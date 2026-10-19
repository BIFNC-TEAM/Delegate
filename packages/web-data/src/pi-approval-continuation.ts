import type { Prisma } from "@prisma/client";

export type PiApprovalContinuationArtifact = {
  id: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  fileName?: string;
};

export type PiApprovalContinuation = {
  version: 1 | 2;
  approvalId: string;
  status: "pending" | "completed";
  artifacts: PiApprovalContinuationArtifact[];
  completedAt?: string;
  checkpoint?: Prisma.InputJsonObject;
  resultStatus?: "completed" | "failed";
};

export function readPiApprovalContinuation(
  snapshot: unknown,
): PiApprovalContinuation | undefined {
  if (!isRecord(snapshot)) return undefined;
  const value = snapshot["piApprovalContinuation"];
  if (!isRecord(value) || ![1, 2].includes(value["version"] as number)) return undefined;
  if (value["version"] === 2 && (!isRecord(value["checkpoint"])
    || value["checkpoint"]["version"] !== 2
    || Buffer.byteLength(JSON.stringify(value["checkpoint"])) > 1024 * 1024)) {
    throw new Error("pi_approval_checkpoint_invalid");
  }
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
    version: value["version"] as 1 | 2,
    approvalId: value["approvalId"],
    status: value["status"],
    artifacts,
    ...(value["version"] === 2 ? { checkpoint: JSON.parse(JSON.stringify(value["checkpoint"])) as Prisma.InputJsonObject,
      resultStatus: value["resultStatus"] === "failed" ? "failed" as const : "completed" as const } : {}),
    ...(typeof value["completedAt"] === "string"
      ? { completedAt: value["completedAt"] }
      : {}),
  };
}

export function markPiApprovalContinuationPending(
  snapshot: unknown,
  approvalId: string,
  checkpoint?: Record<string, unknown>,
) {
  const current = isRecord(snapshot) ? snapshot : {};
  return {
    ...current,
    piApprovalContinuation: {
      version: checkpoint ? 2 : 1,
      approvalId,
      status: "pending",
      artifacts: [],
      ...(checkpoint ? { checkpoint: JSON.parse(JSON.stringify(checkpoint)) as Prisma.InputJsonObject } : {}),
    },
  };
}

export function markPiApprovalContinuationCompleted(
  snapshot: unknown,
  input: {
    approvalId: string;
    completedAt: Date;
    artifacts: PiApprovalContinuationArtifact[];
    resultStatus?: "completed" | "failed";
  },
) {
  const current = isRecord(snapshot) ? snapshot : {};
  const pending = readPiApprovalContinuation(current);
  if (pending?.version === 2 && pending.approvalId !== input.approvalId) throw new Error("pi_approval_checkpoint_action_mismatch");
  return {
    ...current,
    piApprovalContinuation: {
      version: pending?.version ?? 1,
      approvalId: input.approvalId,
      status: "completed",
      completedAt: input.completedAt.toISOString(),
      artifacts: input.artifacts,
      ...(pending?.checkpoint ? { checkpoint: pending.checkpoint, resultStatus: input.resultStatus ?? "completed" } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
