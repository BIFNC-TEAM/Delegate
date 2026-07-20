import { z } from "zod";

export const conversationEpisodeStateSchema = z.enum([
  "active",
  "waiting_user",
  "needs_human",
  "human_active",
  "resolved",
  "archived",
  "failed",
]);

export const generationRunStateSchema = z.enum([
  "queued",
  "processing",
  "waiting_approval",
  "waiting_human",
  "completed",
  "failed",
  "canceled",
]);

export type ConversationEpisodeState = z.infer<typeof conversationEpisodeStateSchema>;
export type GenerationRunState = z.infer<typeof generationRunStateSchema>;

const allowedEpisodeTransitions: Record<ConversationEpisodeState, ConversationEpisodeState[]> = {
  active: ["waiting_user", "needs_human", "human_active", "resolved", "failed"],
  waiting_user: ["active", "needs_human", "human_active", "resolved"],
  needs_human: ["human_active", "active", "resolved"],
  human_active: ["waiting_user", "active", "resolved"],
  resolved: ["active", "archived"],
  archived: ["active"],
  failed: ["active", "needs_human", "resolved"],
};

export function canTransitionConversationEpisode(
  from: ConversationEpisodeState,
  to: ConversationEpisodeState,
): boolean {
  return from === to || allowedEpisodeTransitions[from].includes(to);
}

export function assertConversationEpisodeTransition(
  from: ConversationEpisodeState,
  to: ConversationEpisodeState,
): void {
  if (!canTransitionConversationEpisode(from, to)) {
    throw new Error(`Conversation episode cannot transition from ${from} to ${to}.`);
  }
}

export function resolveInboundEpisodeAction(state: ConversationEpisodeState):
  | "continue"
  | "reopen"
  | "start_new_episode"
  | "hold_for_operator" {
  if (state === "human_active" || state === "needs_human") {
    return "hold_for_operator";
  }

  if (state === "resolved") {
    return "start_new_episode";
  }

  if (state === "archived" || state === "failed") {
    return "reopen";
  }

  return "continue";
}

export function resolveMessageEditAction(state: GenerationRunState):
  | "replace_queued_run"
  | "cancel_and_requeue"
  | "preserve_reply"
  | "update_only" {
  if (state === "queued") return "replace_queued_run";
  if (state === "processing" || state === "waiting_approval" || state === "waiting_human") {
    return "cancel_and_requeue";
  }
  if (state === "completed") return "preserve_reply";
  return "update_only";
}

export function buildMessageRetentionExpiry(
  createdAt: Date,
  retentionDays = 180,
): Date {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("Message retention must be between 1 and 3650 days.");
  }

  return new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

export function buildRedactionPurgeAt(redactedAt: Date, recoveryDays = 7): Date {
  if (!Number.isInteger(recoveryDays) || recoveryDays < 0 || recoveryDays > 30) {
    throw new Error("Redaction recovery must be between 0 and 30 days.");
  }

  return new Date(redactedAt.getTime() + recoveryDays * 24 * 60 * 60 * 1000);
}

export type RuntimePolicyOverlayInput = {
  enabled: boolean;
  priority: number;
  startsAt: Date;
  expiresAt?: Date | null;
  payload: Record<string, unknown>;
};

export function applyRuntimePolicyOverlays(
  versionSnapshot: Record<string, unknown>,
  overlays: RuntimePolicyOverlayInput[],
  now = new Date(),
): Record<string, unknown> {
  const active = overlays
    .filter(
      (overlay) =>
        overlay.enabled &&
        overlay.startsAt.getTime() <= now.getTime() &&
        (!overlay.expiresAt || overlay.expiresAt.getTime() > now.getTime()),
    )
    .sort((left, right) => left.priority - right.priority);

  return active.reduce<Record<string, unknown>>(
    (resolved, overlay) => deepMerge(resolved, overlay.payload),
    structuredClone(versionSnapshot),
  );
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
