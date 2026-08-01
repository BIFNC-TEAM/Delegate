import { sanitizePublicSafeText } from "@delegate/openviking";
import type {
  RepresentativeOpenVikingMemoryPreview,
  RepresentativeOpenVikingSnapshot,
} from "@delegate/web-data";

export type DashboardGovernedContextDto = {
  representativeSlug: string;
  enabled: boolean;
  autoRecall: boolean;
  autoCapture: false;
  recallLimit: number;
  recallScoreThreshold: number;
  serviceStatus: "available" | "unavailable" | "disabled";
  publicKnowledgeSyncAvailable: boolean;
  lastSyncAt?: string;
  lastSyncStatus: string;
  lastSyncItemCount: number;
  recentSyncJobs: Array<{
    status: string;
    itemCount: number;
    startedAt: string;
    finishedAt?: string;
  }>;
  recentCommitActivity: Array<{
    status: string;
    memoriesExtracted?: number;
    createdAt: string;
  }>;
};

export type DashboardGovernedMemoryDto = {
  id: string;
  contactDisplayLabel: string;
  summary: string;
  status: RepresentativeOpenVikingMemoryPreview["status"];
  createdAt: string;
  lastActionAttemptAt?: string;
  actionAttemptCount: number;
};

export function toDashboardGovernedContextDto(
  snapshot: RepresentativeOpenVikingSnapshot,
): DashboardGovernedContextDto {
  return {
    representativeSlug: snapshot.representativeSlug,
    enabled: snapshot.enabled,
    autoRecall: snapshot.autoRecall,
    autoCapture: false,
    recallLimit: snapshot.recallLimit,
    recallScoreThreshold: snapshot.recallScoreThreshold,
    serviceStatus:
      snapshot.health.status === "healthy"
      && snapshot.modelCredentialsAvailable
        ? "available"
        : snapshot.health.status === "disabled"
          ? "disabled"
          : "unavailable",
    publicKnowledgeSyncAvailable:
      snapshot.resourceSyncEnabled
      && snapshot.modelCredentialsAvailable
      && snapshot.health.status === "healthy",
    ...(snapshot.lastSyncAt ? { lastSyncAt: snapshot.lastSyncAt } : {}),
    lastSyncStatus: normalizeActivityStatus(snapshot.lastSyncStatus),
    lastSyncItemCount: Math.max(0, snapshot.lastSyncItemCount),
    recentSyncJobs: snapshot.recentSyncJobs.map((job) => ({
      status: normalizeActivityStatus(job.status),
      itemCount: Math.max(0, job.itemCount),
      startedAt: job.startedAt,
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    })),
    recentCommitActivity: snapshot.recentCommitTraces.map((trace) => ({
      status: normalizeActivityStatus(trace.status),
      ...(typeof trace.memoriesExtracted === "number"
        ? { memoriesExtracted: Math.max(0, trace.memoriesExtracted) }
        : {}),
      createdAt: trace.createdAt,
    })),
  };
}

export function toDashboardGovernedMemoryDto(
  memory: RepresentativeOpenVikingMemoryPreview,
): DashboardGovernedMemoryDto {
  return {
    id: memory.id,
    contactDisplayLabel:
      sanitizePublicSafeText(memory.contact?.displayName ?? "", 120) ??
      "Unknown audience",
    summary:
      memory.status === "DELETED"
        ? ""
        : sanitizePublicSafeText(memory.summary, 480) ?? "",
    status: memory.status,
    createdAt: memory.createdAt,
    ...(memory.lastDeleteAttemptAt
      ? { lastActionAttemptAt: memory.lastDeleteAttemptAt }
      : {}),
    actionAttemptCount: Math.max(0, memory.deletionAttemptCount),
  };
}

function normalizeActivityStatus(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "idle" ||
    normalized === "running" ||
    normalized === "succeeded" ||
    normalized === "failed" ||
    normalized === "disabled" ||
    normalized === "blocked_unpublished" ||
    normalized === "blocked_missing_credentials" ||
    normalized === "queued" ||
    normalized === "pending" ||
    normalized === "completed"
  ) {
    return normalized;
  }
  if (normalized === "retry_wait") {
    return "pending";
  }
  return "attention_required";
}
