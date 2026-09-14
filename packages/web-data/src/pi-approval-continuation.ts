export type PiApprovalContinuationArtifact = {
  id: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  fileName?: string;
};

export type PiApprovalContinuation = {
  version: 1;
  approvalId: string;
  status: "pending" | "completed";
  artifacts: PiApprovalContinuationArtifact[];
  completedAt?: string;
};

export function readPiApprovalContinuation(
  snapshot: unknown,
): PiApprovalContinuation | undefined {
  if (!isRecord(snapshot)) return undefined;
  const value = snapshot["piApprovalContinuation"];
  if (!isRecord(value) || value["version"] !== 1) return undefined;
  if (typeof value["approvalId"] !== "string") return undefined;
  if (value["status"] !== "pending" && value["status"] !== "completed") {
    return undefined;
  }
  const artifacts = Array.isArray(value["artifacts"])
    ? value["artifacts"].flatMap((artifact) => {
        if (!isRecord(artifact)) return [];
        if (
          typeof artifact["id"] !== "string"
          || typeof artifact["kind"] !== "string"
          || typeof artifact["mimeType"] !== "string"
          || typeof artifact["sizeBytes"] !== "number"
        ) return [];
        return [{
          id: artifact["id"],
          kind: artifact["kind"],
          mimeType: artifact["mimeType"],
          sizeBytes: artifact["sizeBytes"],
          ...(typeof artifact["fileName"] === "string"
            ? { fileName: artifact["fileName"] }
            : {}),
        }];
      })
    : [];
  return {
    version: 1,
    approvalId: value["approvalId"],
    status: value["status"],
    artifacts,
    ...(typeof value["completedAt"] === "string"
      ? { completedAt: value["completedAt"] }
      : {}),
  };
}

export function markPiApprovalContinuationPending(
  snapshot: unknown,
  approvalId: string,
) {
  const current = isRecord(snapshot) ? snapshot : {};
  return {
    ...current,
    piApprovalContinuation: {
      version: 1,
      approvalId,
      status: "pending",
      artifacts: [],
    },
  };
}

export function markPiApprovalContinuationCompleted(
  snapshot: unknown,
  input: {
    approvalId: string;
    completedAt: Date;
    artifacts: PiApprovalContinuationArtifact[];
  },
) {
  const current = isRecord(snapshot) ? snapshot : {};
  return {
    ...current,
    piApprovalContinuation: {
      version: 1,
      approvalId: input.approvalId,
      status: "completed",
      completedAt: input.completedAt.toISOString(),
      artifacts: input.artifacts,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
