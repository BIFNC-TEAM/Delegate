import { createHash } from "node:crypto";

import {
  ChannelDesiredState,
  ChannelHealthStatus,
  ChannelSourceProvider,
  ChannelTransport,
  ConversationAssignmentStatus,
  ConversationEpisodeStatus,
  ConversationParticipantKind,
  DelegationTaskNextActor,
  DelegationTaskStatus,
  DelegationTaskStepStatus,
  GenerationRunStatus,
  HandoffStatus,
  KnowledgeAssetReviewStatus,
  KnowledgeAssetStatus,
  LeadStatus,
  MessageContentType,
  MessageDeliveryStatus,
  MessageSenderType,
  Prisma,
  RepresentativeChannelKind,
  RepresentativeLifecycleState,
  WorkspaceSkillInstallStatus,
  WorkspaceSkillReleaseStatus,
  WorkspaceSkillReviewStatus,
} from "@prisma/client";
import {
  assertConversationEpisodeTransition,
  buildMessageRetentionExpiry,
  buildRedactionPurgeAt,
  resolveInboundEpisodeAction,
  resolveMessageEditAction,
  type ConversationEpisodeState,
  type GenerationRunState,
} from "@delegate/runtime";

import {
  InsufficientAgentUsageCreditsError,
  releaseConversationWalletUsage,
  reserveConversationWalletUsage,
  settleConversationWalletUsage,
  transferAgentUsageEntitlementReservation,
  type AgentUsageChargeSnapshot,
  type UsageChargeClient,
} from "./agent-wallet-usage-charge";
import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";
import { isWorkspaceSkillReleaseRuntimeTrusted } from "./workspace-skills";
import {
  ChannelUnavailableError,
  resolveChannelAvailability,
  resolveMatrixDeliveryEndpointAvailability,
  resolveTelegramDeliveryEndpointAvailability,
} from "./channel-availability";
import {
  consumeIdentityBindingChallenge,
  hasActiveMatrixAudienceConnectionProof,
  privateChannelIdentityProviders,
} from "./audience-identity-binding";
import { resolveDeterministicContactMemorySharingCommand } from "./contact-memory-sharing";
import { resolveAndLockIngressIdentityProvenance } from "./contact-memory-source-evidence";
import {
  provisionMatrixDirectConversation,
  resolveMatrixApplicationServiceConnectionId,
} from "./matrix-provisioning";
import {
  matrixServerNameFromUserId,
} from "./matrix-identifiers";
import {
  enqueueInboundMessageMemoryExtraction,
  invalidateMemoryExtractionForSourceMessage,
  isDeterministicContactMemoryDeleteCommand,
} from "./memory-extraction";
import {
  requestAutomaticContactChannelMemoryDeletionInTransaction,
} from "./memory-governance";
import {
  activateCurrentMemoryChannelDisclosureAfterMessage,
  matrixProviderArrivalFenceMatches,
  matrixProviderArrivalFencePayloadKey,
  readMatrixProviderArrivalFence,
  type MatrixProviderArrivalFence,
} from "./memory-disclosure";
import {
  cancelMemoryUseRunInTransaction,
  failMemoryUseRunInTransaction,
  finalizeMemoryUseGenerationInTransaction,
  revalidateMemoryUseDeliverySourcesInTransaction,
} from "./memory-use-execution";
import {
  lockMatrixRoomSecurityState,
  withActiveMatrixRepresentativeChannelFence,
} from "./matrix-room-security";
import {
  consumeConversationEntitlement,
  releaseConversationEntitlement,
  releaseConversationEntitlementByGenerationRunId,
  reserveConversationEntitlement,
  transferConversationEntitlementByGenerationRunId,
  type ConversationEntitlementReservation,
  type ServiceEntitlementClient,
} from "./service-entitlements";
import { buildWebConversationThreadId } from "./web-audience";

export {
  processNextMemoryExtractionWork,
  processMemoryExtractionRun,
  type MemoryCandidateClassification,
  type MemoryExtractionWorkResult,
} from "./memory-extraction";

export type GenerationWalletReservation = {
  usageChargeId: string;
  tokenAmount: number;
};

export type GenerationModelRuntimeState =
  | "ready"
  | "disabled"
  | "missing_credentials"
  | "unsupported_provider"
  | "invalid_subagent_route";

export type GenerationRuntimeOutcome =
  | {
      mode: "model";
    }
  | {
      mode: "fallback";
      fallbackStrategy: "grounded_knowledge" | "deterministic_preview";
      modelRuntimeState: GenerationModelRuntimeState;
      fallbackReason:
        | "model_unavailable"
        | "provider_failed"
        | "policy_fallback";
    };

export type PublicWebAnswerSourceDisclosure = "general_model";

/**
 * Classify the visitor-facing source disclosure from authoritative generation
 * facts. Search hits and prompt injection are not proof that the answer relied
 * on a source; only an authoritative output citation suppresses the general
 * model disclosure.
 */
export function resolvePublicWebAnswerSourceDisclosure(input: {
  modelGenerated: boolean;
  hasAuthorizedCitation: boolean;
}): PublicWebAnswerSourceDisclosure | null {
  if (!input.modelGenerated || input.hasAuthorizedCitation) {
    return null;
  }
  return "general_model";
}

function mergeGenerationRuntimeOutcome(
  snapshot: Prisma.JsonValue | null,
  outcome: GenerationRuntimeOutcome,
): Prisma.InputJsonObject {
  const current =
    snapshot
    && typeof snapshot === "object"
    && !Array.isArray(snapshot)
      ? snapshot as Prisma.JsonObject
      : {};
  const runtimeOutcome: Prisma.InputJsonObject =
    outcome.mode === "model"
      ? {
          version: 1,
          mode: "model",
        }
      : {
          version: 1,
          mode: "fallback",
          fallbackStrategy: outcome.fallbackStrategy,
          modelRuntimeState: outcome.modelRuntimeState,
          fallbackReason: outcome.fallbackReason,
        };
  return {
    ...current,
    runtimeOutcome,
  };
}

export function readGenerationWalletReservation(
  snapshot: Prisma.JsonValue | null,
): GenerationWalletReservation | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const reservation = (snapshot as Prisma.JsonObject)["walletReservation"];
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) {
    return null;
  }
  const usageChargeId = (reservation as Prisma.JsonObject)["usageChargeId"];
  const tokenAmount = (reservation as Prisma.JsonObject)["tokenAmount"];
  if (
    typeof usageChargeId !== "string" ||
    !usageChargeId.trim() ||
    typeof tokenAmount !== "number" ||
    !Number.isSafeInteger(tokenAmount) ||
    tokenAmount <= 0
  ) {
    return null;
  }
  return { usageChargeId, tokenAmount };
}

export function hasGenerationServiceCreditEntitlement(
  snapshot: Prisma.JsonValue | null,
): boolean {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  return (
    (snapshot as Prisma.JsonObject)["billingMode"] === "service_credit"
    && readGenerationWalletReservation(snapshot) !== null
  );
}

export function runConversationWriteTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return runWithPrismaWriteConflictRetry(
    () => prisma.$transaction(
      operation,
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
    { additionalRetryableCodes: ["P2002"] },
  );
}

export type ConversationInboxItem = {
  id: string;
  contactName: string;
  contactHandle?: string;
  channel: "web" | "matrix" | "telegram";
  state: string;
  episodeState: ConversationEpisodeState;
  assignedOperatorName?: string;
  isPaid: boolean;
  unreadCount: number;
  lastMessage: string;
  lastMessageAt: string;
  lastSenderType: "audience" | "representative" | "operator" | "system" | "tool";
  needsHuman: boolean;
};

export type ConversationInboxSnapshot = {
  representative: {
    id: string;
    slug: string;
    displayName: string;
    timeZone: string;
  };
  metrics: {
    unread: number;
    needsHuman: number;
    humanActive: number;
    failed: number;
    pending: number;
    activeLeads: number;
  };
  conversations: ConversationInboxItem[];
  pending: ConversationPendingItem[];
  leads: ConversationLeadItem[];
};

export type ConversationPendingItem = {
  id: string;
  conversationId?: string;
  kind?: "handoff" | "delegation_task";
  contactName: string;
  reason: string;
  summary: string;
  priority: number;
  status: string;
  createdAt: string;
};

export type ConversationLeadItem = {
  id: string;
  conversationId?: string;
  contactName: string;
  title: string;
  summary?: string;
  kind: string;
  status: string;
  priority: number;
  assignedOperatorName?: string;
  nextFollowUpAt?: string;
  updatedAt: string;
};

export type ConversationGenerationRuntimeOutcome = {
  mode: "model" | "fallback";
  fallbackReason?: "model_unavailable" | "provider_failed" | "policy_fallback";
};

export type ConversationDetailSnapshot = {
  id: string;
  contact: {
    id: string;
    displayName: string;
    username?: string;
    stage: string;
    role: string;
    isPaid: boolean;
  };
  representative: {
    slug: string;
    displayName: string;
  };
  channel: string;
  state: string;
  episode?: {
    id: string;
    sequence: number;
    status: ConversationEpisodeState;
    representativeVersion?: number;
  };
  assignment?: {
    operatorId: string;
    operatorName: string;
  };
  messages: Array<{
    id: string;
    senderType: "audience" | "representative" | "operator" | "system" | "tool";
    senderDisplayName?: string;
    text: string;
    status: string;
    editedAt?: string;
    redactedAt?: string;
    createdAt: string;
    citations: Array<{ title: string; excerpt?: string }>;
  }>;
  runs: Array<{
    id: string;
    status: string;
    model?: string;
    runtimeOutcome?: ConversationGenerationRuntimeOutcome;
    createdAt: string;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
    nextActionBy: string;
    blockingReason?: string;
    stepStatus?: string;
    outputCount: number;
    approvalCount: number;
    updatedAt: string;
  }>;
  notes: Array<{
    id: string;
    authorName: string;
    text: string;
    createdAt: string;
  }>;
};

export type RepresentativeOperationsSnapshot = {
  representative: {
    id: string;
    slug: string;
    displayName: string;
    roleSummary: string;
    lifecycleState: "draft" | "configuring" | "ready" | "published" | "paused" | "archived";
    publicMode: boolean;
    activeVersion?: number;
    timeZone: string;
    updatedAt: string;
  };
  readiness: Array<{
    id: string;
    label: string;
    complete: boolean;
    detail: string;
  }>;
  channels: Array<{
    kind: "web" | "matrix" | "telegram";
    status: string;
    externalUserId?: string;
    lastError?: string;
  }>;
  versions: Array<{
    id: string;
    versionNumber: number;
    changeSummary?: string;
    publishedBy?: string;
    publishedAt: string;
    active: boolean;
  }>;
  metrics: {
    conversations: number;
    knowledgeAssets: number;
    enabledSkills: number;
    openHandoffs: number;
  };
};

export type AcceptInboundMessageInput = {
  representativeSlug: string;
  conversationId: string;
  text: string;
  senderId?: string;
  /** Exact verified LOGTO link from the server-resolved Web principal. */
  sourceIdentityLinkId?: string;
  senderDisplayName?: string;
  clientMessageId: string;
  channel?: "web" | "matrix" | "telegram";
  externalMessageId?: string;
  /** Trusted provider event time. Web callers must not set this value. */
  occurredAt?: Date;
  queueGeneration?: boolean;
  walletBilling?: {
    externalUserId: string;
    representativeId: string;
    freeReplyLimit: number;
    tokenAmount: number;
    currency?: string;
    idempotencyKey: string;
  };
};

export class ServiceCreditRequiredError extends Error {
  readonly code = "SERVICE_CREDIT_REQUIRED";
  readonly effectiveFreeRepliesUsed: number;

  constructor(effectiveFreeRepliesUsed = 0) {
    super("No service credits remain for paid continuation.");
    this.name = "ServiceCreditRequiredError";
    this.effectiveFreeRepliesUsed = effectiveFreeRepliesUsed;
  }
}

export class ActiveDelegationTaskControlError extends Error {
  readonly code = "ACTIVE_DELEGATION_TASK";
  readonly statusCode = 409;

  constructor() {
    super(
      "Wait for the active delegation task to finish, or cancel or reconcile it when those controls become available, before assigning a human operator.",
    );
    this.name = "ActiveDelegationTaskControlError";
  }
}

export class DelegationMessageEditConflictError extends Error {
  readonly code = "DELEGATION_MESSAGE_EDIT_CONFLICT";
  readonly statusCode = 409;

  constructor() {
    super(
      "Messages already used by a delegation task cannot be edited. Cancel the task and submit a new message instead.",
    );
    this.name = "DelegationMessageEditConflictError";
  }
}

export class DelegationMessageRedactionConflictError extends Error {
  readonly code = "DELEGATION_MESSAGE_REDACTION_CONFLICT";
  readonly statusCode = 409;

  constructor() {
    super(
      "Messages used by an active delegation task cannot be redacted. Cancel or reconcile the task first.",
    );
    this.name = "DelegationMessageRedactionConflictError";
  }
}

export class ConversationAiDeliveryControlError extends Error {
  readonly code = "CONVERSATION_HUMAN_ACTIVE";
  readonly statusCode = 409;

  constructor() {
    super(
      "AI delivery was canceled because the conversation is waiting for, or controlled by, a human operator.",
    );
    this.name = "ConversationAiDeliveryControlError";
  }
}

export class ConversationWorkInFlightControlError extends Error {
  readonly code = "CONVERSATION_WORK_IN_FLIGHT";
  readonly statusCode = 409;

  constructor() {
    super(
      "Conversation work is crossing its delivery boundary. Retry operator takeover after it finishes.",
    );
    this.name = "ConversationWorkInFlightControlError";
  }
}

export type MatrixApplicationServiceEvent = {
  event_id?: string;
  type?: string;
  room_id?: string;
  sender?: string;
  state_key?: string;
  origin_server_ts?: number;
  redacts?: string;
  content?: Record<string, unknown>;
  "com.delegate.arrival_fence"?: unknown;
};

export type MatrixApplicationServiceIngestResult = {
  eventId: string;
  status: "processed" | "duplicate" | "ignored" | "failed";
  reason?: string;
};

type MatrixConversationMessageGuard = {
  channelBindingId: string;
  roomId: string;
  audienceMatrixUserId: string;
  representativeMatrixUserId: string;
};

type PersistedMatrixApplicationServiceEvent = {
  eventId: string;
  eventType: string;
  event: MatrixApplicationServiceEvent;
  inboxId: string;
  inboxStatus: string;
  attemptCount: number;
  lastError: string | null;
  privateCredentialHash: string | null;
  arrivalFence: MatrixProviderArrivalFence | null;
};

export type MatrixProviderArrivalAdmissionResult = {
  events: MatrixApplicationServiceEvent[];
  ignored: Array<{
    eventId: string;
    reason:
      | "matrix_provider_arrival_fence_missing"
      | "matrix_provider_arrival_lifecycle_stale";
  }>;
};

const matrixEventProcessingLeaseMs = 30_000;
const matrixEventRetryDelayMs = 2_000;
const matrixEventMaximumAttempts = 5;
const matrixBindingTokenHashContentKey =
  "com.delegate.private_channel_binding_token_hash";
// Public compute sessions are capped at 240 minutes. Keep the default claim
// lease above that hard limit so a healthy long-running worker cannot be
// reclaimed concurrently; deployments may override it, but never below 30s.
// The public compute contract permits runs up to 240 minutes. Until lease
// heartbeats exist, never reclaim a live run inside that window.
const conversationOutboxProcessingLeaseMs = 5 * 60 * 60_000;
const telegramWorkerOwnershipRetryMs = 30_000;
const cancellableGenerationStatuses: GenerationRunStatus[] = [
  GenerationRunStatus.QUEUED,
  GenerationRunStatus.PROCESSING,
  GenerationRunStatus.WAITING_APPROVAL,
  GenerationRunStatus.WAITING_HUMAN,
];

const episodeStateMap: Record<ConversationEpisodeStatus, ConversationEpisodeState> = {
  ACTIVE: "active",
  WAITING_USER: "waiting_user",
  WAITING_APPROVAL: "waiting_approval",
  NEEDS_HUMAN: "needs_human",
  HUMAN_ACTIVE: "human_active",
  RESOLVED: "resolved",
  ARCHIVED: "archived",
  FAILED: "failed",
};

const generationStateMap: Record<GenerationRunStatus, GenerationRunState> = {
  QUEUED: "queued",
  PROCESSING: "processing",
  WAITING_APPROVAL: "waiting_approval",
  WAITING_HUMAN: "waiting_human",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELED: "canceled",
};

const activeGenerationOutboxStatuses = [
  "PENDING",
  "PROCESSING",
  "FAILED",
] as const;

function markGenerationWalletTransferred(
  snapshot: Prisma.JsonValue | null,
  replacementRunId: string,
): Prisma.InputJsonObject | null {
  if (!isJsonRecord(snapshot) || !readGenerationWalletReservation(snapshot)) {
    return null;
  }
  const {
    walletReservation: _walletReservation,
    ...rest
  } = snapshot;
  return {
    ...rest,
    billingMode: `${String(snapshot["billingMode"] ?? "service_credit")}_transferred`,
    billingTransferredToGenerationRunId: replacementRunId,
    walletReservationTransferredTo: replacementRunId,
  } as Prisma.InputJsonObject;
}

function markGenerationWalletReleased(
  snapshot: Prisma.JsonValue | null,
  now: Date,
): Prisma.InputJsonObject | null {
  if (!isJsonRecord(snapshot) || !readGenerationWalletReservation(snapshot)) {
    return null;
  }
  const {
    walletReservation: _walletReservation,
    ...rest
  } = snapshot;
  return {
    ...rest,
    billingMode: "service_credit_released",
    billingFinalizedAt: now.toISOString(),
  } as Prisma.InputJsonObject;
}

function delegationTaskOwnsGenerationBilling(input: {
  delegationTaskId?: string | null;
  delegationTaskStep?: { kind: string } | null;
}): boolean {
  if (!input.delegationTaskId) return false;
  return input.delegationTaskStep?.kind !== "CLARIFICATION";
}

export async function listConversationInboxSnapshot(
  representativeSlug: string,
  operatorId = "local-owner",
  ownerId?: string | null,
): Promise<ConversationInboxSnapshot | null> {
  const scopedOwnerId = ownerId?.trim();
  if (!process.env.DATABASE_URL?.trim()) {
    if (scopedOwnerId) {
      throw new Error("Conversation inbox is temporarily unavailable.");
    }
    return buildDemoInboxSnapshot(representativeSlug);
  }

  try {
    const representative = await prisma.representative.findFirst({
      where: {
        slug: representativeSlug,
        ...(scopedOwnerId ? { ownerId: scopedOwnerId } : {}),
      },
      select: {
        id: true,
        slug: true,
        displayName: true,
        owner: { select: { timezone: true } },
      },
    });
    if (!representative) return null;

    const [conversations, handoffs, delegationTasks, leads] = await Promise.all([
      prisma.conversation.findMany({
      where: { representativeId: representative.id },
      include: {
        contact: true,
        episodes: {
          include: { representativeVersion: { select: { versionNumber: true } } },
          orderBy: { sequence: "desc" },
          take: 1,
        },
        assignments: {
          where: { status: ConversationAssignmentStatus.ACTIVE },
          orderBy: { assignedAt: "desc" },
          take: 1,
        },
        messages: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
        },
        turns: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
        },
        generationRuns: {
          where: { status: GenerationRunStatus.FAILED },
          take: 1,
        },
        readStates: {
          where: { operatorId },
          take: 1,
        },
      },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: 100,
      }),
      prisma.handoffRequest.findMany({
        where: {
          representativeId: representative.id,
          status: { in: [HandoffStatus.OPEN, HandoffStatus.REVIEWING] },
        },
        include: { contact: true },
        orderBy: [{ recommendedPriority: "desc" }, { createdAt: "asc" }],
        take: 100,
      }),
      prisma.delegationTask.findMany({
        where: {
          representativeId: representative.id,
          status: {
            in: [
              "DRAFT",
              "CLARIFYING",
              "READY",
              "AWAITING_APPROVAL",
              "QUEUED",
              "RUNNING",
              "WAITING_FOR_USER",
              "WAITING_FOR_OWNER",
              "FAILED",
            ],
          },
        },
        include: { contact: true },
        orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
        take: 100,
      }),
      prisma.lead.findMany({
        where: {
          representativeId: representative.id,
          status: { notIn: [LeadStatus.WON, LeadStatus.LOST, LeadStatus.ARCHIVED] },
        },
        include: { contact: true },
        orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
        take: 100,
      }),
    ]);

    const items = conversations.map<ConversationInboxItem>((conversation) => {
      const episode = conversation.episodes[0];
      const lastMessage = conversation.messages[0];
      const lastTurn = conversation.turns[0];
      const episodeState = episode ? episodeStateMap[episode.status] : legacyStateToEpisodeState(conversation.state);
      const assignment = conversation.assignments[0];

      return {
        id: conversation.id,
        contactName:
          conversation.contact.displayName ||
          conversation.contact.username ||
          `Visitor ${conversation.contact.id.slice(-5)}`,
        ...(conversation.contact.username ? { contactHandle: conversation.contact.username } : {}),
        channel: normalizeChannel(conversation.sourceChannel),
        state: conversation.state.toLowerCase(),
        episodeState,
        ...(assignment ? { assignedOperatorName: assignment.operatorName } : {}),
        isPaid: conversation.contact.isPaid,
        unreadCount:
          conversation.readStates[0]?.lastReadAt &&
          conversation.readStates[0].lastReadAt >= conversation.lastMessageAt
            ? 0
            : conversation.unreadCount,
        lastMessage: lastMessage?.text || lastTurn?.messageText || "No messages yet",
        lastMessageAt: (lastMessage?.createdAt || lastTurn?.createdAt || conversation.lastMessageAt).toISOString(),
        lastSenderType: lastMessage
          ? normalizeSenderType(lastMessage.senderType)
          : lastTurn?.direction === "outbound"
            ? "representative"
            : "audience",
        needsHuman: episodeState === "needs_human" || episodeState === "human_active",
      };
    });
    const pending: ConversationPendingItem[] = [
      ...delegationTasks.map((task) => ({
        id: task.id,
        ...(task.originConversationId ? { conversationId: task.originConversationId } : {}),
        kind: "delegation_task" as const,
        contactName: task.contact?.displayName || task.contact?.username || `Task ${task.id.slice(-5)}`,
        reason: task.nextActionBy === "OWNER"
          ? "owner_action"
          : task.nextActionBy === "AUDIENCE"
            ? "user_input"
            : "delegated_execution",
        summary: task.title,
        priority: task.priority,
        status: task.status.toLowerCase(),
        createdAt: task.createdAt.toISOString(),
      })),
      ...handoffs.map((item) => ({
        id: item.id,
        ...(item.conversationId ? { conversationId: item.conversationId } : {}),
        kind: "handoff" as const,
        contactName: item.contact.displayName || item.contact.username || `Visitor ${item.contact.id.slice(-5)}`,
        reason: item.reason,
        summary: item.summary,
        priority: item.recommendedPriority,
        status: item.status.toLowerCase(),
        createdAt: item.createdAt.toISOString(),
      })),
    ];

    return {
      representative: {
        id: representative.id,
        slug: representative.slug,
        displayName: representative.displayName,
        timeZone: normalizeIanaTimeZone(representative.owner.timezone),
      },
      metrics: {
        unread: items.reduce((total, item) => total + item.unreadCount, 0),
        needsHuman: items.filter((item) => item.episodeState === "needs_human").length,
        humanActive: items.filter((item) => item.episodeState === "human_active").length,
        failed: conversations.filter((conversation) => conversation.generationRuns.length > 0).length,
        pending: pending.length,
        activeLeads: leads.length,
      },
      conversations: items,
      pending,
      leads: leads.map((item) => ({
        id: item.id,
        ...(item.conversationId ? { conversationId: item.conversationId } : {}),
        contactName: item.contact.displayName || item.contact.username || `Visitor ${item.contact.id.slice(-5)}`,
        title: item.title,
        ...(item.summary ? { summary: item.summary } : {}),
        kind: item.kind,
        status: item.status.toLowerCase(),
        priority: item.priority,
        ...(item.assignedOperatorName ? { assignedOperatorName: item.assignedOperatorName } : {}),
        ...(item.nextFollowUpAt ? { nextFollowUpAt: item.nextFollowUpAt.toISOString() } : {}),
        updatedAt: item.updatedAt.toISOString(),
      })),
    };
  } catch (error) {
    if (isConversationPlatformUnavailable(error)) {
      if (scopedOwnerId) {
        throw new Error("Conversation inbox is temporarily unavailable.");
      }
      return buildDemoInboxSnapshot(representativeSlug);
    }
    throw error;
  }
}

export async function getConversationDetailSnapshot(
  representativeSlug: string,
  conversationId: string,
  ownerId?: string | null,
): Promise<ConversationDetailSnapshot | null> {
  const scopedOwnerId = ownerId?.trim();
  if (!process.env.DATABASE_URL?.trim()) {
    if (scopedOwnerId) {
      throw new Error("Conversation detail is temporarily unavailable.");
    }
    return buildDemoConversationDetail(representativeSlug, conversationId);
  }

  try {
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        representative: {
          slug: representativeSlug,
          ...(scopedOwnerId ? { ownerId: scopedOwnerId } : {}),
        },
      },
      include: {
        representative: { select: { slug: true, displayName: true } },
        contact: true,
        episodes: {
          include: { representativeVersion: { select: { versionNumber: true } } },
          orderBy: { sequence: "desc" },
          take: 1,
        },
        assignments: {
          where: { status: ConversationAssignmentStatus.ACTIVE },
          orderBy: { assignedAt: "desc" },
          take: 1,
        },
        messages: {
          include: { citations: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 200,
        },
        turns: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 200,
        },
        generationRuns: {
          orderBy: { createdAt: "desc" },
          take: 20,
        },
        delegationTasks: {
          include: {
            steps: { orderBy: { sequence: "asc" }, take: 1 },
            _count: { select: { outputs: true, approvalRequests: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 20,
        },
        internalNotes: {
          orderBy: { createdAt: "desc" },
          take: 50,
        },
      },
    });
    if (!conversation) return null;

    const episode = conversation.episodes[0];
    const assignment = conversation.assignments[0];
    const messages = conversation.messages.length
      ? conversation.messages.map((message) => ({
          id: message.id,
          senderType: normalizeSenderType(message.senderType),
          ...(message.senderDisplayName ? { senderDisplayName: message.senderDisplayName } : {}),
          text: message.redactedAt ? "Message redacted" : message.text || "",
          status: message.deliveryStatus.toLowerCase(),
          ...(message.editedAt ? { editedAt: message.editedAt.toISOString() } : {}),
          ...(message.redactedAt ? { redactedAt: message.redactedAt.toISOString() } : {}),
          createdAt: message.createdAt.toISOString(),
          citations: message.citations.map((citation) => ({
            title: citation.title,
            ...(citation.excerpt ? { excerpt: citation.excerpt } : {}),
          })),
        }))
      : conversation.turns.map((turn) => ({
          id: turn.id,
          senderType: turn.direction === "outbound" ? ("representative" as const) : ("audience" as const),
          text: turn.messageText,
          status: "sent",
          createdAt: turn.createdAt.toISOString(),
          citations: [],
        }));

    return {
      id: conversation.id,
      contact: {
        id: conversation.contact.id,
        displayName:
          conversation.contact.displayName ||
          conversation.contact.username ||
          `Visitor ${conversation.contact.id.slice(-5)}`,
        ...(conversation.contact.username ? { username: conversation.contact.username } : {}),
        stage: conversation.contact.stage.toLowerCase(),
        role: conversation.contact.role.toLowerCase(),
        isPaid: conversation.contact.isPaid,
      },
      representative: conversation.representative,
      channel: normalizeChannel(conversation.sourceChannel),
      state: conversation.state.toLowerCase(),
      ...(episode
        ? {
            episode: {
              id: episode.id,
              sequence: episode.sequence,
              status: episodeStateMap[episode.status],
              ...(episode.representativeVersion
                ? { representativeVersion: episode.representativeVersion.versionNumber }
                : {}),
            },
          }
        : {}),
      ...(assignment
        ? { assignment: { operatorId: assignment.operatorId, operatorName: assignment.operatorName } }
        : {}),
      messages,
      runs: conversation.generationRuns.map((run) => {
        const runtimeOutcome = readConversationGenerationRuntimeOutcome(
          run.contextSnapshot,
        );
        return {
          id: run.id,
          status: run.status.toLowerCase(),
          ...(run.model ? { model: run.model } : {}),
          ...(runtimeOutcome ? { runtimeOutcome } : {}),
          createdAt: run.createdAt.toISOString(),
        };
      }),
      tasks: conversation.delegationTasks.map((task) => ({
        id: task.id,
        title: task.title,
        kind: task.kind.toLowerCase(),
        status: task.status.toLowerCase(),
        nextActionBy: task.nextActionBy.toLowerCase(),
        ...(task.blockingReason ? { blockingReason: task.blockingReason } : {}),
        ...(task.steps[0] ? { stepStatus: task.steps[0].status.toLowerCase() } : {}),
        outputCount: task._count.outputs,
        approvalCount: task._count.approvalRequests,
        updatedAt: task.updatedAt.toISOString(),
      })),
      notes: conversation.internalNotes.map((note) => ({
        id: note.id,
        authorName: note.authorName,
        text: note.text,
        createdAt: note.createdAt.toISOString(),
      })),
    };
  } catch (error) {
    if (isConversationPlatformUnavailable(error)) {
      if (scopedOwnerId) {
        throw new Error("Conversation detail is temporarily unavailable.");
      }
      return buildDemoConversationDetail(representativeSlug, conversationId);
    }
    throw error;
  }
}

export async function getRepresentativeOperationsSnapshot(
  input: {
    representativeSlug: string;
    ownerId?: string | null;
  },
): Promise<RepresentativeOperationsSnapshot | null> {
  const representativeSlug = input.representativeSlug.trim();
  const ownerId = input.ownerId?.trim();
  if (!representativeSlug) return null;

  if (!process.env.DATABASE_URL?.trim()) {
    if (ownerId) {
      throw new Error("Representative operations are temporarily unavailable.");
    }
    return buildDemoRepresentativeOperations(representativeSlug);
  }

  try {
    const representative = await prisma.representative.findFirst({
      where: {
        slug: representativeSlug,
        ...(ownerId ? { ownerId } : {}),
      },
      include: {
        activeVersion: { select: { id: true, versionNumber: true } },
        owner: { select: { timezone: true } },
        versions: { orderBy: { versionNumber: "desc" }, take: 20 },
        channelBindings: { orderBy: { kind: "asc" } },
        knowledgeAssetLinks: { where: { enabled: true } },
        skillPackLinks: {
          where: { enabled: true },
          include: {
            skillPack: true,
            workspaceInstall: {
              include: {
                releases: {
                  where: { status: WorkspaceSkillReleaseStatus.INSTALLED },
                  orderBy: { adoptedAt: "desc" },
                  take: 1,
                },
              },
            },
            mcpBindings: { select: { enabled: true } },
          },
        },
        knowledgePack: true,
        pricingPlans: true,
        _count: { select: { conversations: true, handoffRequests: true } },
      },
    });
    if (!representative) return null;

    const readiness = buildRepresentativeReadiness({
      displayName: representative.displayName,
      roleSummary: representative.roleSummary,
      tone: representative.tone,
      publicMode: representative.publicMode,
      humanInLoop: representative.humanInLoop,
      handoffPrompt: representative.handoffPrompt,
      knowledgeCount: representative.knowledgeAssetLinks.length,
      knowledgePackItemCount: countKnowledgePackItems(representative.knowledgePack),
      pricingCount: representative.pricingPlans.length,
      channelCount: representative.channelBindings.length,
      enabledSkillCount: representative.skillPackLinks.length,
      skillIssueCount: countRepresentativeSkillIssues(representative.skillPackLinks),
    });

    return {
      representative: {
        id: representative.id,
        slug: representative.slug,
        displayName: representative.displayName,
        roleSummary: representative.roleSummary,
        lifecycleState: representative.lifecycleState.toLowerCase() as RepresentativeOperationsSnapshot["representative"]["lifecycleState"],
        publicMode: representative.publicMode,
        ...(representative.activeVersion
          ? { activeVersion: representative.activeVersion.versionNumber }
          : {}),
        timeZone: normalizeIanaTimeZone(representative.owner.timezone),
        updatedAt: representative.updatedAt.toISOString(),
      },
      readiness,
      channels: representative.channelBindings.map((binding) => ({
        kind: binding.kind.toLowerCase() as "web" | "matrix" | "telegram",
        status: binding.status.toLowerCase(),
        ...(binding.externalUserId ? { externalUserId: binding.externalUserId } : {}),
        ...(binding.lastError ? { lastError: binding.lastError } : {}),
      })),
      versions: representative.versions.map((version) => ({
        id: version.id,
        versionNumber: version.versionNumber,
        ...(version.changeSummary ? { changeSummary: version.changeSummary } : {}),
        ...(version.publishedBy ? { publishedBy: version.publishedBy } : {}),
        publishedAt: version.publishedAt.toISOString(),
        active: version.id === representative.activeVersion?.id,
      })),
      metrics: {
        conversations: representative._count.conversations,
        knowledgeAssets: representative.knowledgeAssetLinks.length,
        enabledSkills: representative.skillPackLinks.length,
        openHandoffs: representative._count.handoffRequests,
      },
    };
  } catch (error) {
    if (isConversationPlatformUnavailable(error)) {
      if (ownerId) {
        throw new Error("Representative operations are temporarily unavailable.");
      }
      return buildDemoRepresentativeOperations(representativeSlug);
    }
    throw error;
  }
}

export async function acceptInboundConversationMessage(
  input: AcceptInboundMessageInput,
  existingTransaction?: Prisma.TransactionClient,
) {
  const text = input.text.trim();
  if (!text) throw new Error("Message text is required.");
  if (!input.clientMessageId.trim()) throw new Error("clientMessageId is required.");
  const inboundOccurredAt = resolveInboundMessageOccurredAt(input);

  const accept = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))`;
    const conversation = await tx.conversation.findFirst({
      where: { id: input.conversationId, representative: { slug: input.representativeSlug } },
      include: {
        representative: {
          select: {
            id: true,
            activeVersionId: true,
            lifecycleState: true,
            publicMode: true,
            runtimePolicyOverlays: {
              where: { enabled: true },
              select: {
                enabled: true,
                priority: true,
                startsAt: true,
                expiresAt: true,
                payload: true,
              },
            },
          },
        },
        episodes: { orderBy: { sequence: "desc" }, take: 1 },
        channelBindings: {
          include: {
            representativeBinding: {
              select: {
                status: true,
                desiredState: true,
                healthStatus: true,
                connectionId: true,
                externalUserId: true,
                telegramBotConnectionId: true,
                endpointAssignmentRevision: true,
                endpointLifecycleRevision: true,
                telegramBotConnection: {
                  select: {
                    id: true,
                    botId: true,
                    status: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!conversation) throw new Error("Conversation not found.");

    const normalizedChannel = normalizeChannel(input.channel ?? null);
    const channelKind = mapChannelKind(input.channel);
    const binding = conversation.channelBindings.find((item) => item.kind === channelKind);
    const availability = resolveChannelAvailability({
      channel: normalizedChannel,
      lifecycleState: conversation.representative.lifecycleState,
      activeVersionId: conversation.representative.activeVersionId,
      publicMode: conversation.representative.publicMode,
      binding: binding
        ? binding.representativeBinding
          ? {
              legacyStatus: binding.representativeBinding.status,
              desiredState: binding.representativeBinding.desiredState,
              healthStatus: binding.representativeBinding.healthStatus,
            }
          : normalizedChannel === "web"
            ? {
                legacyStatus: "CONNECTED",
                desiredState: "ACTIVE",
                healthStatus: "UNKNOWN",
              }
            : null
        : null,
      ...(normalizedChannel === "telegram" && binding
        ? {
            telegramEndpoint: {
              conversationConnectionId: binding.connectionId,
              representativeConnectionId:
                binding.representativeBinding?.connectionId,
              conversationRepresentativeAssignmentRevision:
                binding.representativeAssignmentRevision,
              representativeAssignmentRevision:
                binding.representativeBinding
                  ?.endpointAssignmentRevision,
              representativeTelegramBotConnectionId:
                binding.representativeBinding?.telegramBotConnectionId,
              representativeTelegramBot:
                binding.representativeBinding?.telegramBotConnection,
            },
          }
        : {}),
      ...(normalizedChannel === "matrix" && binding
        ? {
            matrixEndpoint: {
              conversationRepresentativeMatrixUserId:
                readMatrixRepresentativeUserId(binding.metadata),
              representativeMatrixUserId:
                binding.representativeBinding?.externalUserId,
              conversationRepresentativeAssignmentRevision:
                binding.representativeAssignmentRevision,
              representativeAssignmentRevision:
                binding.representativeBinding
                  ?.endpointAssignmentRevision,
            },
          }
        : {}),
      overlays: (conversation.representative.runtimePolicyOverlays ?? []).map((overlay) => ({
        ...overlay,
        payload: isJsonRecord(overlay.payload) ? overlay.payload : {},
      })),
    });
    if (!availability.available) {
      throw new ChannelUnavailableError(availability.code);
    }
    if (input.channel === "matrix") {
      const matrixBindingSafe = binding
        ? await lockAndVerifyMatrixDirectBinding(tx, {
            id: binding.id,
            externalConversationId: binding.externalConversationId,
          })
        : false;
      if (!matrixBindingSafe) {
        throw new ChannelUnavailableError(
          "matrix_private_room_not_verified",
        );
      }
    }

    const ingressIdentityProvenance =
      await resolveAndLockIngressIdentityProvenance(tx, {
        sourceChannel: channelKind,
        audienceIdentityId: conversation.audienceIdentityId,
        senderId: input.senderId ?? null,
        connectionId: binding?.connectionId ?? null,
        webIdentityLinkId: input.sourceIdentityLinkId ?? null,
      });
    if (
      (normalizedChannel === "matrix" || normalizedChannel === "telegram")
      && !ingressIdentityProvenance
    ) {
      throw new ChannelUnavailableError(
        "identity_provenance_invalid",
      );
    }
    if (
      normalizedChannel === "web"
      && input.sourceIdentityLinkId
      && !ingressIdentityProvenance
    ) {
      throw new ChannelUnavailableError(
        "identity_provenance_invalid",
      );
    }

    const existingRun = await tx.generationRun.findUnique({
      where: {
        idempotencyKey: `reply:${conversation.id}:${input.clientMessageId}`,
      },
      include: { inputMessage: true },
    });
    if (existingRun) {
      if (
        existingRun.inputMessage.sourceIdentityLinkId
          !== ingressIdentityProvenance?.sourceIdentityLinkId
        || existingRun.inputMessage.sourceIdentityConnectionProofId
          !== ingressIdentityProvenance?.sourceIdentityConnectionProofId
      ) {
        throw new ChannelUnavailableError(
          "identity_provenance_invalid",
        );
      }
      return {
        message: existingRun.inputMessage,
        run: existingRun,
        heldForOperator: false,
        walletReservation: null,
        replayed: true,
      };
    }

    const latestEpisode = conversation.episodes[0];
    const latestState = latestEpisode ? episodeStateMap[latestEpisode.status] : "active";
    const action = resolveInboundEpisodeAction(latestState);
    const shouldQueueAi =
      action !== "hold_for_operator" && input.queueGeneration !== false;
    let episode = latestEpisode;

    if (!episode || action === "start_new_episode") {
      episode = await tx.conversationEpisode.create({
        data: {
          conversationId: conversation.id,
          representativeVersionId: conversation.representative.activeVersionId,
          sequence: (latestEpisode?.sequence ?? 0) + 1,
          status: ConversationEpisodeStatus.ACTIVE,
        },
      });
    } else if (action === "reopen") {
      episode = await tx.conversationEpisode.update({
        where: { id: episode.id },
        data: { status: ConversationEpisodeStatus.ACTIVE, endedAt: null },
      });
    } else if (shouldQueueAi && latestState === "waiting_user") {
      assertConversationEpisodeTransition(latestState, "active");
      episode = await tx.conversationEpisode.update({
        where: { id: episode.id },
        data: { status: ConversationEpisodeStatus.ACTIVE },
      });
    }

    let billingMode: "free" | "service_credit" | null = null;
    let effectiveFreeRepliesUsed = conversation.freeRepliesUsed;
    if (shouldQueueAi && input.walletBilling) {
      if (input.walletBilling.representativeId !== conversation.representative.id) {
        throw new Error(
          "Wallet billing representative does not match the conversation.",
        );
      }
      const retryableFailedRunIds = (
        await tx.outboxEvent.findMany({
          where: {
            conversationId: conversation.id,
            aggregateType: "generation_run",
            eventType: "generation.requested",
            status: "FAILED",
            attemptCount: { lt: 5 },
          },
          select: { aggregateId: true },
        })
      ).map((event) => event.aggregateId);
      const freeInFlight = await tx.generationRun.count({
        where: {
          conversationId: conversation.id,
          OR: [
            {
              status: {
                in: [
                  GenerationRunStatus.QUEUED,
                  GenerationRunStatus.PROCESSING,
                  GenerationRunStatus.WAITING_APPROVAL,
                ],
              },
            },
            {
              id: { in: retryableFailedRunIds },
              status: GenerationRunStatus.FAILED,
            },
          ],
          runtimePolicySnapshot: {
            path: ["billingMode"],
            equals: "free",
          },
        },
      });
      effectiveFreeRepliesUsed = conversation.freeRepliesUsed + freeInFlight;
      billingMode =
        effectiveFreeRepliesUsed >= input.walletBilling.freeReplyLimit
          ? "service_credit"
          : "free";
    }
    const createdAt = inboundOccurredAt;
    const message = await tx.message.upsert({
      where: {
        conversationId_clientMessageId: {
          conversationId: conversation.id,
          clientMessageId: input.clientMessageId,
        },
      },
      create: {
        conversationId: conversation.id,
        episodeId: episode.id,
        ...(binding ? { channelBindingId: binding.id } : {}),
        ...(ingressIdentityProvenance
          ? {
              sourceIdentityLinkId:
                ingressIdentityProvenance.sourceIdentityLinkId,
              sourceIdentityConnectionProofId:
                ingressIdentityProvenance.sourceIdentityConnectionProofId,
            }
          : {}),
        senderType: MessageSenderType.AUDIENCE,
        ...(input.senderId ? { senderId: input.senderId } : {}),
        ...(input.senderDisplayName ? { senderDisplayName: input.senderDisplayName } : {}),
        contentType: MessageContentType.TEXT,
        text,
        clientMessageId: input.clientMessageId,
        ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
        ...(
          (normalizedChannel === "matrix" || normalizedChannel === "telegram")
          && binding?.representativeBinding
          && binding.representativeBinding.endpointLifecycleRevision > 0
            ? {
                channelLifecycleRevision:
                  binding.representativeBinding.endpointLifecycleRevision,
              }
            : {}
        ),
        deliveryStatus:
          input.queueGeneration === false
            ? MessageDeliveryStatus.SENT
            : MessageDeliveryStatus.QUEUED,
        retentionExpiresAt: buildMessageRetentionExpiry(createdAt),
        createdAt,
      },
      update: {},
    });

    if (normalizedChannel === "matrix" || normalizedChannel === "telegram") {
      await activateCurrentMemoryChannelDisclosureAfterMessage(tx, {
        representativeId: conversation.representative.id,
        contactId: conversation.contactId,
        conversationId: conversation.id,
        messageId: message.id,
        channel: normalizedChannel,
      });
    }

    if (isDeterministicContactMemoryDeleteCommand(text)) {
      await requestAutomaticContactChannelMemoryDeletionInTransaction(tx, {
        representativeId: conversation.representative.id,
        contactId: conversation.contactId,
        sourceChannel: channelKind,
        sourceMessageId: message.id,
        sourceHash: createHash("sha256").update(text).digest("hex"),
        occurredAt: new Date(),
      });
    } else if (!resolveDeterministicContactMemorySharingCommand(text)) {
      await enqueueInboundMessageMemoryExtraction(tx, {
        representativeId: conversation.representative.id,
        contactId: conversation.contactId,
        conversationId: conversation.id,
        messageId: message.id,
        channel: normalizedChannel,
      });
    }

    let run = shouldQueueAi
      ? await tx.generationRun.upsert({
          where: { idempotencyKey: `reply:${conversation.id}:${input.clientMessageId}` },
          create: {
            conversationId: conversation.id,
            episodeId: episode.id,
            inputMessageId: message.id,
            representativeVersionId: episode.representativeVersionId,
            status: GenerationRunStatus.QUEUED,
            idempotencyKey: `reply:${conversation.id}:${input.clientMessageId}`,
            ...(billingMode
              ? {
                  runtimePolicySnapshot: {
                    billingMode,
                  },
                }
              : {}),
          },
          update: {},
        })
      : null;

    if (run) {
      let reservedUsage: AgentUsageChargeSnapshot | null = null;
      if (billingMode === "service_credit") {
        if (!input.walletBilling) {
          throw new Error(
            "Service-credit billing requires server-owned wallet coordinates.",
          );
        }
        if (!conversation.audienceIdentityId) {
          throw new Error(
            "Paid conversation does not have a canonical audience identity.",
          );
        }
        try {
          const reservation = await reserveConversationWalletUsage(
            {
              externalUserId: input.walletBilling.externalUserId,
              audienceIdentityId: conversation.audienceIdentityId,
              representativeId: conversation.representative.id,
              conversationId: conversation.id,
              generationRunId: run.id,
              tokenAmount: input.walletBilling.tokenAmount,
              ...(input.walletBilling.currency
                ? { currency: input.walletBilling.currency }
                : {}),
              idempotencyKey: input.walletBilling.idempotencyKey,
            },
            tx as unknown as UsageChargeClient,
          );
          reservedUsage = reservation.usageCharge;
        } catch (error) {
          if (error instanceof InsufficientAgentUsageCreditsError) {
            throw new ServiceCreditRequiredError(effectiveFreeRepliesUsed);
          }
          throw error;
        }
        run = await tx.generationRun.update({
          where: { id: run.id },
          data: {
            runtimePolicySnapshot: {
              billingMode,
              walletReservation: {
                usageChargeId: reservedUsage.id,
                tokenAmount: reservedUsage.reservedTokenAmount,
              },
            },
          },
        });
      }
      await tx.outboxEvent.upsert({
        where: { idempotencyKey: `generation.requested:${run.id}` },
        create: {
          conversationId: conversation.id,
          aggregateType: "generation_run",
          aggregateId: run.id,
          eventType: "generation.requested",
          ...(binding?.transport ? { transport: binding.transport } : {}),
          ...(binding?.sourceProvider
            ? { sourceProvider: binding.sourceProvider }
            : {}),
          ...(binding?.connectionId
            ? { connectionId: binding.connectionId }
            : {}),
          payload: { runId: run.id, conversationId: conversation.id, messageId: message.id },
          idempotencyKey: `generation.requested:${run.id}`,
        },
        update: {},
      });

      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          activeEpisodeId: episode.id,
          state: "AI_QUEUED",
          unreadCount: { increment: 1 },
          lastMessageAt: createdAt,
        },
      });

      return {
        message,
        run,
        heldForOperator: false,
        walletReservation: reservedUsage,
        replayed: false,
      };
    }

    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        activeEpisodeId: episode.id,
        state:
          action === "hold_for_operator"
            ? latestState === "human_active"
              ? "HUMAN_ACTIVE"
              : "NEEDS_HUMAN"
            : run
              ? "AI_QUEUED"
              : conversation.state,
        unreadCount: { increment: 1 },
        lastMessageAt: createdAt,
      },
    });

    return {
      message,
      run: null,
      heldForOperator: !shouldQueueAi,
      walletReservation: null,
      replayed: false,
    };
  };
  return existingTransaction
    ? accept(existingTransaction)
    : runConversationWriteTransaction(accept);
}

export async function assertConversationChannelDeliveryAvailable(input: {
  conversationId: string;
  channel: "web" | "matrix" | "telegram";
  senderMode?: "ai" | "operator";
  allowNeedsHumanDelivery?: boolean;
}) {
  const kind = mapChannelKind(input.channel);
  const conversation = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: {
      state: true,
      representative: {
        select: {
          lifecycleState: true,
          activeVersionId: true,
          publicMode: true,
          runtimePolicyOverlays: {
            where: { enabled: true },
            select: {
              enabled: true,
              priority: true,
              startsAt: true,
              expiresAt: true,
              payload: true,
            },
          },
        },
      },
      channelBindings: {
        where: { kind },
        take: 1,
        select: {
          metadata: true,
          connectionId: true,
          representativeAssignmentRevision: true,
          representativeBinding: {
            select: {
              status: true,
              desiredState: true,
              healthStatus: true,
              connectionId: true,
              externalUserId: true,
              telegramBotConnectionId: true,
              endpointAssignmentRevision: true,
              telegramBotConnection: {
                select: {
                  id: true,
                  botId: true,
                  status: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!conversation) throw new Error("Conversation not found.");
  if (
    input.senderMode === "ai"
    && (
      conversation.state === "HUMAN_ACTIVE"
      || (
        conversation.state === "NEEDS_HUMAN"
        && !input.allowNeedsHumanDelivery
      )
    )
  ) {
    throw new ConversationAiDeliveryControlError();
  }
  const channelBinding = conversation.channelBindings[0];
  if (
    input.channel === "matrix"
    && (!channelBinding || !isMatrixDirectBindingSafe(channelBinding.metadata))
  ) {
    throw new ChannelUnavailableError("matrix_private_room_not_verified");
  }
  const binding = channelBinding?.representativeBinding;
  const availability = resolveChannelAvailability({
    channel: input.channel,
    lifecycleState: conversation.representative.lifecycleState,
    activeVersionId: conversation.representative.activeVersionId,
    publicMode: conversation.representative.publicMode,
    binding: binding
      ? {
          legacyStatus: binding.status,
          desiredState: binding.desiredState,
          healthStatus: binding.healthStatus,
        }
      : null,
    ...(input.channel === "telegram" && channelBinding
      ? {
          telegramEndpoint: {
            conversationConnectionId: channelBinding.connectionId,
            representativeConnectionId: binding?.connectionId,
            conversationRepresentativeAssignmentRevision:
              channelBinding.representativeAssignmentRevision,
            representativeAssignmentRevision:
              binding?.endpointAssignmentRevision,
            representativeTelegramBotConnectionId:
              binding?.telegramBotConnectionId,
            representativeTelegramBot: binding?.telegramBotConnection,
          },
        }
      : {}),
    ...(input.channel === "matrix" && channelBinding
      ? {
          matrixEndpoint: {
            conversationRepresentativeMatrixUserId:
              readMatrixRepresentativeUserId(channelBinding.metadata),
            representativeMatrixUserId: binding?.externalUserId,
            conversationRepresentativeAssignmentRevision:
              channelBinding.representativeAssignmentRevision,
            representativeAssignmentRevision:
              binding?.endpointAssignmentRevision,
          },
        }
      : {}),
    overlays: conversation.representative.runtimePolicyOverlays.map((overlay) => ({
      ...overlay,
      payload: isJsonRecord(overlay.payload) ? overlay.payload : {},
    })),
  });
  if (!availability.available) throw new ChannelUnavailableError(availability.code);
}

/**
 * Persists the worker's free-quota decision on the leased generation run so
 * Compute Broker can authorize the exact server-owned run without consulting
 * legacy contact unlock flags or trusting a client payload.
 */
export async function authorizeGenerationRunFreeUsage(input: {
  runId: string;
  outboxId: string;
  leaseAttempt: number;
  freeReplyLimit: number;
}) {
  if (
    !Number.isSafeInteger(input.freeReplyLimit)
    || input.freeReplyLimit < 0
  ) {
    throw new Error("freeReplyLimit must be a non-negative integer.");
  }
  return runConversationWriteTransaction(async (tx) => {
    const runScope = await tx.generationRun.findUnique({
      where: { id: input.runId },
      select: { conversationId: true },
    });
    if (!runScope) throw new Error("Generation run not found.");
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${runScope.conversationId}))
    `;
    await fenceGenerationWorkLease(tx, input);
    const run = await tx.generationRun.findUnique({
      where: { id: input.runId },
      select: {
        id: true,
        conversationId: true,
        runtimePolicySnapshot: true,
        conversation: { select: { freeRepliesUsed: true } },
      },
    });
    if (!run) throw new Error("Generation run not found.");
    if (run.conversationId !== runScope.conversationId) {
      throw new Error("Generation run conversation changed during free authorization.");
    }
    const snapshot =
      run.runtimePolicySnapshot
      && typeof run.runtimePolicySnapshot === "object"
      && !Array.isArray(run.runtimePolicySnapshot)
        ? run.runtimePolicySnapshot as Prisma.JsonObject
        : {};
    if (readGenerationWalletReservation(snapshot)) {
      throw new Error(
        "Wallet-authorized generation cannot be downgraded to free usage.",
      );
    }
    const billingMode = snapshot["billingMode"];
    if (
      typeof billingMode === "string"
      && billingMode !== "free"
    ) {
      throw new Error(
        `Generation billing mode ${billingMode} cannot be changed to free.`,
      );
    }
    if (billingMode === "free") return true;

    const retryableFailedRunIds = (
      await tx.outboxEvent.findMany({
        where: {
          conversationId: run.conversationId,
          aggregateType: "generation_run",
          eventType: "generation.requested",
          status: "FAILED",
          attemptCount: { lt: 5 },
        },
        select: { aggregateId: true },
      })
    ).map((event) => event.aggregateId);
    const freeInFlight = await tx.generationRun.count({
      where: {
        conversationId: run.conversationId,
        id: { not: run.id },
        OR: [
          {
            status: {
              in: [
                GenerationRunStatus.QUEUED,
                GenerationRunStatus.PROCESSING,
                GenerationRunStatus.WAITING_APPROVAL,
              ],
            },
          },
          {
            id: { in: retryableFailedRunIds },
            status: GenerationRunStatus.FAILED,
          },
        ],
        runtimePolicySnapshot: {
          path: ["billingMode"],
          equals: "free",
        },
      },
    });
    if (
      run.conversation.freeRepliesUsed + freeInFlight
      >= input.freeReplyLimit
    ) {
      return false;
    }
    await tx.generationRun.update({
      where: { id: run.id },
      data: {
        runtimePolicySnapshot: {
          ...snapshot,
          billingMode: "free",
        },
      },
    });
    return true;
  });
}

export async function completeInlineGenerationRun(input: {
  conversationId: string;
  runId: string;
  outboxId: string;
  leaseAttempt: number;
  replyText: string;
  senderDisplayName: string;
  intent?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costCents?: number;
  runtimeOutcome?: GenerationRuntimeOutcome;
  completeOutbox?: boolean;
  countUsage: boolean;
  keepConversationQueued?: boolean;
  humanHandoff?: {
    reason: string;
    summary: string;
    kind?: string;
    priority?: number;
    source?: string;
  };
  entitlementReservation?: ConversationEntitlementReservation;
  attachments?: Array<{
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    artifactId: string;
    url: string;
  }>;
  memoryUse?:
    | {
        runId: string;
        outcome: "completed";
        injectedItemIds: string[];
        citedItemIds: string[];
      }
    | {
        runId: string;
        outcome: "generation_failed";
      };
}) {
  const replyText = input.replyText.trim();
  if (!replyText) throw new Error("Reply text is required.");
  if (input.keepConversationQueued && input.humanHandoff) {
    throw new Error(
      "A generation run cannot queue another AI step while requesting human handoff.",
    );
  }

  const completedResult = await runConversationWriteTransaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))
    `;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.runId}))`;
    await fenceGenerationWorkLease(tx, input);
    const run = await tx.generationRun.findUnique({
      where: { id: input.runId },
      include: {
        outputMessage: true,
        inputMessage: {
          select: {
            id: true,
            channelLifecycleRevision: true,
            channelBinding: {
              select: {
                id: true,
                kind: true,
                externalConversationId: true,
                metadata: true,
                representativeAssignmentRevision: true,
                representativeBinding: {
                  select: {
                    externalUserId: true,
                    endpointAssignmentRevision: true,
                    endpointLifecycleRevision: true,
                  },
                },
              },
            },
          },
        },
        conversation: {
          select: {
            id: true,
            state: true,
            audienceIdentityId: true,
            representativeId: true,
          },
        },
        delegationTaskStep: { select: { kind: true } },
      },
    });
    if (!run) throw new Error("Generation run not found.");
    if (run.conversationId !== input.conversationId) {
      throw new Error("Generation run does not belong to the conversation.");
    }
    if (run.status === GenerationRunStatus.COMPLETED && run.outputMessage) {
      return { run, message: run.outputMessage };
    }
    if (run.status === GenerationRunStatus.CANCELED) {
      throw new Error("Generation run was canceled.");
    }
    const delegationTaskOwnsBilling =
      delegationTaskOwnsGenerationBilling(run);
    if (
      run.conversation.state === "HUMAN_ACTIVE"
      || run.conversation.state === "NEEDS_HUMAN"
    ) {
      const deferredAt = new Date();
      await releaseConversationEntitlementByGenerationRunId(
        {
          generationRunId: run.id,
          reason: "generation_deferred_for_human",
        },
        tx as unknown as ServiceEntitlementClient,
      );
      const walletReservation = readGenerationWalletReservation(
        run.runtimePolicySnapshot,
      );
      let releasedSnapshot: Prisma.InputJsonObject | null = null;
      if (walletReservation && !delegationTaskOwnsBilling) {
        await releaseConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
            expectedGenerationRunId: run.id,
            reason: "generation_deferred_to_human",
            idempotencyKey: `generation:${run.id}:release`,
          },
          tx as unknown as UsageChargeClient,
        );
        releasedSnapshot = markGenerationWalletReleased(
          run.runtimePolicySnapshot,
          deferredAt,
        );
      }
      await tx.generationRun.update({
        where: { id: run.id },
        data: {
          status: GenerationRunStatus.WAITING_HUMAN,
          completedAt: null,
          canceledAt: null,
          ...(releasedSnapshot
            ? { runtimePolicySnapshot: releasedSnapshot }
            : {}),
        },
      });
      await tx.message.update({
        where: { id: run.inputMessageId },
        data: {
          deliveryStatus: MessageDeliveryStatus.SENT,
          failureCode: null,
          failureReason: null,
        },
      });
      await cancelStartedMemoryUseForGeneration(
        tx,
        run.id,
        "memory_handoff_canceled",
        deferredAt,
      );
      const completedOutbox = await tx.outboxEvent.updateMany({
        where: {
          id: input.outboxId,
          aggregateType: "generation_run",
          aggregateId: run.id,
          eventType: "generation.requested",
          status: "PROCESSING",
          attemptCount: input.leaseAttempt,
        },
        data: {
          status: "PROCESSED",
          processedAt: deferredAt,
          lastError: null,
        },
      });
      if (completedOutbox.count !== 1) {
        throw new GenerationWorkLeaseLostError(
          input.outboxId,
          input.leaseAttempt,
        );
      }
      return { deferredForHuman: true as const };
    }
    const matrixBinding =
      run.inputMessage?.channelBinding?.kind === RepresentativeChannelKind.MATRIX
        ? run.inputMessage.channelBinding
        : null;
    const matrixLifecycleCurrent = !matrixBinding || (
      Number.isSafeInteger(run.inputMessage.channelLifecycleRevision)
      && (run.inputMessage.channelLifecycleRevision ?? 0) > 0
      && Number.isSafeInteger(
        matrixBinding.representativeBinding?.endpointLifecycleRevision,
      )
      && (matrixBinding.representativeBinding
        ?.endpointLifecycleRevision ?? 0) > 0
      && run.inputMessage.channelLifecycleRevision
        === matrixBinding.representativeBinding
          ?.endpointLifecycleRevision
    );
    const matrixEndpointAvailability = matrixBinding
      ? resolveMatrixDeliveryEndpointAvailability({
          conversationRepresentativeMatrixUserId:
            readMatrixRepresentativeUserId(matrixBinding.metadata),
          representativeMatrixUserId:
            matrixBinding.representativeBinding?.externalUserId,
          conversationRepresentativeAssignmentRevision:
            matrixBinding.representativeAssignmentRevision,
          representativeAssignmentRevision:
            matrixBinding.representativeBinding
              ?.endpointAssignmentRevision,
        })
      : null;
    const matrixRoomSafe = matrixBinding
      && matrixEndpointAvailability?.available === true
      ? await lockAndVerifyMatrixDirectBinding(tx, {
          id: matrixBinding.id,
          externalConversationId: matrixBinding.externalConversationId,
        })
      : false;
    if (
      matrixBinding
      && (
        !matrixEndpointAvailability?.available
        || !matrixRoomSafe
        || !matrixLifecycleCurrent
      )
    ) {
      const endpointUnavailable = matrixEndpointAvailability?.available === false;
      const failureCode = endpointUnavailable
        ? matrixEndpointAvailability.code
        : !matrixRoomSafe
          ? "matrix_private_room_not_verified"
          : "matrix_channel_lifecycle_reactivated";
      const identityReassigned =
        failureCode === "matrix_identity_reassigned";
      const canceledAt = new Date();
      await releaseConversationEntitlementByGenerationRunId(
        {
          generationRunId: run.id,
          reason: failureCode,
        },
        tx as unknown as ServiceEntitlementClient,
      );
      const walletReservation = readGenerationWalletReservation(
        run.runtimePolicySnapshot,
      );
      if (walletReservation && !delegationTaskOwnsBilling) {
        await releaseConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
            expectedGenerationRunId: run.id,
            failed: true,
            reason: failureCode,
            idempotencyKey: `generation:${run.id}:release`,
          },
          tx as unknown as UsageChargeClient,
        );
      }
      await tx.generationRun.updateMany({
        where: {
          id: run.id,
          status: { in: cancellableGenerationStatuses },
        },
        data: {
          status: GenerationRunStatus.CANCELED,
          errorCode: failureCode,
          errorMessage:
            identityReassigned
              ? "Generation canceled because the Matrix room belongs to a previously assigned representative identity."
              : failureCode === "matrix_channel_lifecycle_reactivated"
                ? "Generation canceled because it belongs to an earlier Matrix channel activation."
                : "Generation canceled because the Matrix room is no longer a verified private conversation.",
          canceledAt,
        },
      });
      await tx.message.update({
        where: { id: run.inputMessageId },
        data: {
          deliveryStatus: MessageDeliveryStatus.CANCELED,
          failureCode,
          failureReason:
            identityReassigned
              ? "The Matrix room belongs to a previously assigned representative identity."
              : failureCode === "matrix_channel_lifecycle_reactivated"
                ? "The request belongs to an earlier Matrix channel activation."
                : "The Matrix room is no longer a verified private conversation.",
        },
      });
      await tx.conversation.updateMany({
        where: {
          id: run.conversationId,
          state: { in: ["AI_QUEUED", "PROCESSING", "WAITING_APPROVAL"] },
        },
        data: { state: "FAILED" },
      });
      if (run.episodeId) {
        await tx.conversationEpisode.updateMany({
          where: {
            id: run.episodeId,
            status: {
              in: [
                ConversationEpisodeStatus.ACTIVE,
                ConversationEpisodeStatus.WAITING_APPROVAL,
              ],
            },
          },
          data: { status: ConversationEpisodeStatus.FAILED },
        });
      }
      await tx.outboxEvent.updateMany({
        where: {
          aggregateType: "generation_run",
          aggregateId: run.id,
          status: { in: ["PENDING", "PROCESSING", "FAILED"] },
        },
        data: {
          status: "DEAD_LETTER",
          processedAt: canceledAt,
          lastError: failureCode,
        },
      });
      await cancelStartedMemoryUseForGeneration(
        tx,
        run.id,
        "memory_generation_canceled",
        canceledAt,
      );
      return { channelUnavailableCode: failureCode };
    }
    if (!delegationTaskOwnsBilling && input.entitlementReservation) {
      const reservation = input.entitlementReservation;
      if (
        reservation.generationRunId !== run.id
        || reservation.representativeId !== run.conversation.representativeId
      ) {
        throw new Error(
          "Conversation entitlement reservation does not belong to this generation run.",
        );
      }
      const finalizedEntitlement = input.countUsage
        ? await consumeConversationEntitlement(
            reservation,
            tx as unknown as ServiceEntitlementClient,
          )
        : await releaseConversationEntitlement(
            reservation,
            tx as unknown as ServiceEntitlementClient,
          );
      if (
        finalizedEntitlement.audienceIdentityId
        !== run.conversation.audienceIdentityId
      ) {
        throw new Error(
          "Conversation entitlement reservation belongs to a different audience identity.",
        );
      }
    } else if (!delegationTaskOwnsBilling && !input.countUsage) {
      await releaseConversationEntitlementByGenerationRunId(
        {
          generationRunId: run.id,
          reason: "generation_usage_not_counted",
        },
        tx as unknown as ServiceEntitlementClient,
      );
    }

    const walletReservation = readGenerationWalletReservation(
      run.runtimePolicySnapshot,
    );
    const now = new Date();
    const message = await tx.message.create({
      data: {
        conversationId: run.conversationId,
        episodeId: run.episodeId,
        senderType: MessageSenderType.REPRESENTATIVE,
        senderDisplayName: input.senderDisplayName,
        delegationTaskId: run.delegationTaskId,
        contentType: MessageContentType.TEXT,
        text: replyText,
        ...(input.intent || input.humanHandoff
          ? {
              content: {
                ...(input.intent ? { intent: input.intent } : {}),
                ...(input.humanHandoff
                  ? {
                      deliveryControl: {
                        allowNeedsHuman: true,
                        generationRunId: run.id,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        deliveryStatus:
          input.completeOutbox === false
            ? MessageDeliveryStatus.QUEUED
            : MessageDeliveryStatus.SENT,
        retentionExpiresAt: buildMessageRetentionExpiry(now),
        createdAt: now,
        ...(input.attachments?.length
          ? {
              attachments: {
                create: input.attachments.map((attachment) => ({
                  fileName: attachment.fileName,
                  mimeType: attachment.mimeType ?? null,
                  sizeBytes: attachment.sizeBytes ?? null,
                  objectKey: attachment.artifactId,
                  externalUrl: attachment.url,
                })),
              },
            }
          : {}),
      },
    });
    const completed = await tx.generationRun.update({
      where: { id: run.id },
      data: {
        outputMessageId: message.id,
        status: GenerationRunStatus.COMPLETED,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
        ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
        ...(input.costCents !== undefined ? { costCents: input.costCents } : {}),
        ...(input.runtimeOutcome
          ? {
              contextSnapshot: mergeGenerationRuntimeOutcome(
                run.contextSnapshot,
                input.runtimeOutcome,
              ),
            }
          : {}),
        startedAt: run.startedAt || now,
        completedAt: now,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (input.memoryUse?.outcome === "completed") {
      await finalizeMemoryUseGenerationInTransaction(tx, {
        useRunId: input.memoryUse.runId,
        outputMessageId: message.id,
        injectedItemIds: input.memoryUse.injectedItemIds,
        citedItemIds: input.memoryUse.citedItemIds,
      }, now);
    } else if (input.memoryUse?.outcome === "generation_failed") {
      await failMemoryUseRunInTransaction(
        tx,
        input.memoryUse.runId,
        "memory_generation_failed",
        now,
      );
    }
    await tx.message.update({
      where: { id: run.inputMessageId },
      data: { deliveryStatus: MessageDeliveryStatus.SENT },
    });
    await tx.conversation.updateMany({
      where: {
        id: run.conversationId,
        state: { notIn: ["HUMAN_ACTIVE", "NEEDS_HUMAN"] },
      },
      data: {
        state: input.humanHandoff
          ? "NEEDS_HUMAN"
          : input.keepConversationQueued
            ? "AI_QUEUED"
            : "WAITING_USER",
      },
    });
    await tx.conversation.update({
      where: { id: run.conversationId },
      data: {
        lastMessageAt: now,
        ...(!input.countUsage || walletReservation || delegationTaskOwnsBilling
          ? {}
          : { freeRepliesUsed: { increment: 1 } }),
      },
    });
    await tx.conversationEpisode.updateMany({
      where: {
        id: run.episodeId || "__no_episode__",
        status: {
          notIn: [
            ConversationEpisodeStatus.HUMAN_ACTIVE,
            ConversationEpisodeStatus.NEEDS_HUMAN,
          ],
        },
      },
      data: {
        status: input.humanHandoff
          ? ConversationEpisodeStatus.NEEDS_HUMAN
          : input.keepConversationQueued
            ? ConversationEpisodeStatus.ACTIVE
            : ConversationEpisodeStatus.WAITING_USER,
      },
    });
    if (input.humanHandoff) {
      await ensureConversationLeadAndHandoffInTransaction(tx, {
        conversationId: run.conversationId,
        ...input.humanHandoff,
        requestHandoff: true,
      });
    }
    if (input.completeOutbox !== false) {
      const completedOutbox = await tx.outboxEvent.updateMany({
        where: {
          id: input.outboxId,
          aggregateType: "generation_run",
          aggregateId: run.id,
          eventType: "generation.requested",
          status: "PROCESSING",
          attemptCount: input.leaseAttempt,
        },
        data: { status: "PROCESSED", processedAt: now },
      });
      if (completedOutbox.count !== 1) {
        throw new GenerationWorkLeaseLostError(
          input.outboxId,
          input.leaseAttempt,
        );
      }
    }
    if (walletReservation && !delegationTaskOwnsBilling) {
      if (!input.countUsage) {
        await releaseConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
            expectedGenerationRunId: run.id,
            reason: "generation_usage_not_counted",
            idempotencyKey: `generation:${run.id}:release`,
          },
          tx as unknown as UsageChargeClient,
        );
      } else {
        await settleConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
            expectedGenerationRunId: run.id,
            settledTokenAmount: walletReservation.tokenAmount,
            ...(input.costCents !== undefined
              ? { providerCostCents: input.costCents }
              : {}),
            ...(input.provider ? { provider: input.provider } : {}),
            idempotencyKey: `generation:${run.id}:settle`,
          },
          tx as unknown as UsageChargeClient,
        );
      }
    }
    return { run: completed, message };
  });
  if ("channelUnavailableCode" in completedResult) {
    throw new ChannelUnavailableError(
      completedResult.channelUnavailableCode,
    );
  }
  if ("deferredForHuman" in completedResult) {
    throw new ConversationAiDeliveryControlError();
  }
  return completedResult;
}

async function cancelStartedMemoryUseForGeneration(
  tx: Prisma.TransactionClient,
  generationRunId: string,
  reasonCode: "memory_generation_canceled" | "memory_handoff_canceled",
  occurredAt: Date,
) {
  const memoryUseRun = await tx.memoryUseRun.findFirst({
    where: {
      generationRunId,
      status: "STARTED",
    },
    select: { id: true },
  });
  if (!memoryUseRun) return;
  await cancelMemoryUseRunInTransaction(
    tx,
    memoryUseRun.id,
    reasonCode,
    occurredAt,
  );
}

export async function waitGenerationRunForComputeApproval(input: {
  conversationId: string;
  runId: string;
  outboxId: string;
  leaseAttempt: number;
  approvalId: string;
  replyText: string;
  senderDisplayName: string;
}) {
  const replyText = input.replyText.trim();
  if (!replyText) throw new Error("Approval waiting reply text is required.");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))
    `;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.runId}))`;
    await fenceGenerationWorkLease(tx, input);
    const run = await tx.generationRun.findUnique({
      where: { id: input.runId },
      include: { outputMessage: true },
    });
    if (!run) throw new Error("Generation run not found.");
    if (run.conversationId !== input.conversationId) {
      throw new Error("Generation run does not belong to the conversation.");
    }
    if (run.status === GenerationRunStatus.COMPLETED && run.outputMessage) {
      return { run, message: run.outputMessage };
    }
    if (run.status === GenerationRunStatus.WAITING_APPROVAL && run.outputMessage) {
      return { run, message: run.outputMessage };
    }
    if (run.status === GenerationRunStatus.CANCELED) {
      throw new Error("Generation run was canceled.");
    }
    const conversation = await tx.conversation.findUnique({
      where: { id: input.conversationId },
      select: { state: true },
    });
    if (!conversation) throw new Error("Conversation not found.");
    if (
      conversation.state === "HUMAN_ACTIVE"
      || conversation.state === "NEEDS_HUMAN"
    ) {
      throw new ConversationAiDeliveryControlError();
    }

    const approval = await tx.approvalRequest.findUnique({
      where: { id: input.approvalId },
      select: { id: true, conversationId: true },
    });
    if (!approval || approval.conversationId !== run.conversationId) {
      throw new Error("Compute approval does not belong to this generation run conversation.");
    }

    const now = new Date();
    const message = await tx.message.create({
      data: {
        conversationId: run.conversationId,
        episodeId: run.episodeId,
        senderType: MessageSenderType.REPRESENTATIVE,
        senderDisplayName: input.senderDisplayName,
        delegationTaskId: run.delegationTaskId,
        contentType: MessageContentType.TEXT,
        text: replyText,
        content: { kind: "compute_approval_pending", approvalId: input.approvalId },
        clientMessageId: `compute-approval-pending:${input.approvalId}`,
        deliveryStatus: MessageDeliveryStatus.SENT,
        retentionExpiresAt: buildMessageRetentionExpiry(now),
        createdAt: now,
      },
    });
    const waitingRun = await tx.generationRun.update({
      where: { id: run.id },
      data: {
        outputMessageId: message.id,
        status: GenerationRunStatus.WAITING_APPROVAL,
        startedAt: run.startedAt || now,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    await tx.approvalRequest.update({
      where: { id: input.approvalId },
      data: {
        generationRunId: run.id,
        delegationTaskId: run.delegationTaskId,
        delegationTaskStepId: run.delegationTaskStepId,
      },
    });
    await tx.message.update({
      where: { id: run.inputMessageId },
      data: { deliveryStatus: MessageDeliveryStatus.SENT },
    });
    await tx.conversation.update({
      where: { id: run.conversationId },
      data: { state: "WAITING_APPROVAL", lastMessageAt: now },
    });
    await tx.conversationEpisode.updateMany({
      where: { id: run.episodeId || "__no_episode__" },
      data: { status: ConversationEpisodeStatus.WAITING_APPROVAL },
    });
    const completedOutbox = await tx.outboxEvent.updateMany({
      where: {
        id: input.outboxId,
        aggregateType: "generation_run",
        aggregateId: run.id,
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: input.leaseAttempt,
      },
      data: { status: "PROCESSED", processedAt: now },
    });
    if (completedOutbox.count !== 1) {
      throw new GenerationWorkLeaseLostError(
        input.outboxId,
        input.leaseAttempt,
      );
    }
    return { run: waitingRun, message };
  });
}

export type ClaimedGenerationWorkItem = {
  outboxId: string;
  /**
   * The outbox attempt that owns the current visibility lease. Workers pass
   * this value back when renewing so an older worker cannot extend a lease
   * after a newer attempt has reclaimed the item.
   */
  leaseAttempt: number;
  runId: string;
  delegationTaskId?: string;
  delegationTaskStepId?: string;
  contextSnapshot?: unknown;
  representativeVersionId: string | null;
  representativeSlug: string;
  representativeName: string;
  conversationId: string;
  contactId: string;
  audienceIdentityId?: string;
  controlState: string;
  episodeId?: string;
  inputMessageId: string;
  userText: string;
  sourceSenderId?: string;
  privateChannelConnectionId?: string;
  channel: "web" | "matrix" | "telegram";
  externalConversationId?: string;
  telegramConnectionId?: string;
  matrixSenderUserId?: string;
  matrixEndpointLifecycleRevision?: number;
  deliveryOnly?: boolean;
  outputMessageId?: string;
  outputText?: string;
  delegationTerminalRecovery?: {
    taskStatus: string;
    stepStatus: string;
    attachments: Array<{
      fileName: string;
      mimeType?: string;
      sizeBytes?: number;
      artifactId: string;
      url: string;
    }>;
  };
  walletReservation?: GenerationWalletReservation;
  usage: {
    freeRepliesUsed: number;
    passUnlocked: boolean;
    deepHelpUnlocked: boolean;
  };
};

export const GENERATION_WORK_MAX_ATTEMPTS = 5;
export const GENERATION_WORK_LEASE_DURATION_MS = 5 * 60_000;

const GENERATION_WORK_LEASE_EXHAUSTED_ERROR = "generation_work_lease_exhausted";
const GENERATION_WORK_LEASE_LOST_ERROR = "generation_work_lease_lost";
const GENERATION_MEMORY_DELIVERY_BLOCKED_ERROR =
  "generation_memory_delivery_source_revoked";
const DELEGATION_EXTERNAL_EFFECT_LEASE_LOST_ERROR =
  "delegation_external_effect_lease_lost";

export type GenerationWorkLease = {
  outboxId: string;
  leaseAttempt: number;
};

export class GenerationWorkLeaseLostError extends Error {
  readonly code = GENERATION_WORK_LEASE_LOST_ERROR;

  constructor(readonly outboxId: string, readonly leaseAttempt: number) {
    super("The conversation worker no longer owns this generation work lease.");
    this.name = "GenerationWorkLeaseLostError";
  }
}

export function isGenerationWorkLeaseLostError(
  error: unknown,
): error is GenerationWorkLeaseLostError {
  return error instanceof GenerationWorkLeaseLostError
    || (
      error instanceof Error
      && "code" in error
      && error.code === GENERATION_WORK_LEASE_LOST_ERROR
    );
}

export class GenerationMemoryDeliveryBlockedError extends Error {
  readonly code = GENERATION_MEMORY_DELIVERY_BLOCKED_ERROR;

  constructor() {
    super(
      "Generation delivery was canceled because an injected source is no longer authorized.",
    );
    this.name = "GenerationMemoryDeliveryBlockedError";
  }
}

export function isGenerationMemoryDeliveryBlockedError(
  error: unknown,
): error is GenerationMemoryDeliveryBlockedError {
  return error instanceof GenerationMemoryDeliveryBlockedError
    || (
      error instanceof Error
      && "code" in error
      && error.code === GENERATION_MEMORY_DELIVERY_BLOCKED_ERROR
    );
}

export async function fenceGenerationWorkLease(
  tx: Prisma.TransactionClient,
  input: GenerationWorkLease & { runId: string },
) {
  if (
    !input.outboxId
    || !Number.isSafeInteger(input.leaseAttempt)
    || input.leaseAttempt < 1
  ) {
    throw new GenerationWorkLeaseLostError(
      input.outboxId,
      input.leaseAttempt,
    );
  }

  // The no-op status assignment deliberately takes a row lock. Any concurrent
  // reclaim must either happen first (and make this predicate miss) or wait
  // until this transaction commits. All business writes after this point are
  // therefore owned by exactly one lease attempt and roll back with the fence.
  const fenced = await tx.outboxEvent.updateMany({
    where: {
      id: input.outboxId,
      aggregateType: "generation_run",
      aggregateId: input.runId,
      eventType: "generation.requested",
      status: "PROCESSING",
      attemptCount: input.leaseAttempt,
      availableAt: { gt: new Date() },
    },
    data: { status: "PROCESSING" },
  });
  if (fenced.count !== 1) {
    throw new GenerationWorkLeaseLostError(
      input.outboxId,
      input.leaseAttempt,
    );
  }
}

export async function reserveGenerationConversationEntitlement(input: {
  runId: string;
  outboxId: string;
  leaseAttempt: number;
  audienceIdentityId: string;
  representativeId: string;
  productCodes?: string[];
}) {
  return runConversationWriteTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.runId}))`;
    await fenceGenerationWorkLease(tx, input);
    return reserveConversationEntitlement(
      {
        audienceIdentityId: input.audienceIdentityId,
        representativeId: input.representativeId,
        generationRunId: input.runId,
        ...(input.productCodes ? { productCodes: input.productCodes } : {}),
      },
      tx as unknown as ServiceEntitlementClient,
    );
  });
}

export async function claimNextGenerationWorkItem(
  options: {
    telegramWorkerEnabled?: boolean;
    processingLeaseMs?: number;
  } = {},
): Promise<ClaimedGenerationWorkItem | null> {
  return runConversationWriteTransaction(async (tx) => {
    const selectedCandidates = await tx.$queryRaw<Array<{
      id: string;
      aggregateId: string;
      conversationId: string | null;
      delegationTaskId: string | null;
      status: string;
      attemptCount: number;
    }>>`
      SELECT
        outbox."id",
        outbox."aggregateId",
        run."conversationId" AS "conversationId",
        outbox."status",
        outbox."attemptCount",
        run."delegationTaskId" AS "delegationTaskId"
      FROM "OutboxEvent" AS outbox
      LEFT JOIN "GenerationRun" AS run
        ON run."id" = outbox."aggregateId"
      WHERE outbox."eventType" = 'generation.requested'
        AND outbox."availableAt" <= NOW()
        AND (
          (
            outbox."status" IN ('PENDING', 'FAILED')
            AND outbox."attemptCount" < ${GENERATION_WORK_MAX_ATTEMPTS}
          )
          OR outbox."status" = 'PROCESSING'
        )
      ORDER BY
        CASE
          WHEN outbox."status" = 'PROCESSING'
            AND outbox."attemptCount" >= ${GENERATION_WORK_MAX_ATTEMPTS}
          THEN 0
          ELSE 1
        END,
        outbox."createdAt" ASC
      LIMIT 1
    `;
    const selectedCandidate = selectedCandidates[0];
    if (!selectedCandidate) return null;

    if (selectedCandidate.conversationId) {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${selectedCandidate.conversationId})
        )
      `;
    }
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${selectedCandidate.aggregateId}))
    `;
    if (selectedCandidate.delegationTaskId) {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${selectedCandidate.delegationTaskId})
        )
      `;
    }

    const lockedCandidates = await tx.$queryRaw<Array<{
      id: string;
      aggregateId: string;
      status: string;
      attemptCount: number;
    }>>`
      SELECT
        outbox."id",
        outbox."aggregateId",
        outbox."status",
        outbox."attemptCount"
      FROM "OutboxEvent" AS outbox
      LEFT JOIN "GenerationRun" AS run
        ON run."id" = outbox."aggregateId"
      WHERE outbox."id" = ${selectedCandidate.id}
        AND outbox."eventType" = 'generation.requested'
        AND outbox."availableAt" <= NOW()
        AND run."conversationId"
          IS NOT DISTINCT FROM ${selectedCandidate.conversationId}
        AND run."delegationTaskId"
          IS NOT DISTINCT FROM ${selectedCandidate.delegationTaskId}
        AND (
          (
            outbox."status" IN ('PENDING', 'FAILED')
            AND outbox."attemptCount" < ${GENERATION_WORK_MAX_ATTEMPTS}
          )
          OR outbox."status" = 'PROCESSING'
        )
      FOR UPDATE OF outbox SKIP LOCKED
    `;
    const candidate = lockedCandidates[0];
    if (!candidate) return null;

    if (
      candidate.status === "PROCESSING"
      && candidate.attemptCount >= GENERATION_WORK_MAX_ATTEMPTS
    ) {
      await terminalizeExpiredGenerationLease(
        tx,
        candidate.aggregateId,
        candidate.id,
        { recoverLatestTerminalDelegationResult: true },
      );
      return null;
    }

    const processingLeaseMs = Math.max(
      GENERATION_WORK_LEASE_DURATION_MS,
      options.processingLeaseMs ?? GENERATION_WORK_LEASE_DURATION_MS,
    );
    const outbox = await tx.outboxEvent.update({
      where: { id: candidate.id },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        availableAt: new Date(Date.now() + processingLeaseMs),
        processedAt: null,
        lastError: null,
      },
    });
    const runId = outbox.aggregateId;
    const run = await tx.generationRun.findUnique({
      where: { id: runId },
      include: {
        inputMessage: {
          include: {
            channelBinding: {
              include: {
                representativeBinding: {
                  select: {
                    status: true,
                    desiredState: true,
                    healthStatus: true,
                    connectionId: true,
                    externalUserId: true,
                    telegramBotConnectionId: true,
                    endpointAssignmentRevision: true,
                    endpointLifecycleRevision: true,
                    telegramBotConnection: {
                      select: {
                        id: true,
                        botId: true,
                        status: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        outputMessage: true,
        delegationTask: {
          select: { status: true },
        },
        delegationTaskStep: {
          select: {
            kind: true,
            status: true,
            externalEffects: {
              where: { status: "EXECUTING" },
              select: { id: true },
              take: 1,
            },
            outputs: {
              where: { artifactId: { not: null } },
              select: {
                artifact: {
                  select: {
                    id: true,
                    kind: true,
                    mimeType: true,
                    sizeBytes: true,
                  },
                },
              },
              take: 20,
            },
          },
        },
        episode: {
          select: {
            representativeVersionId: true,
          },
        },
        conversation: {
          include: {
            representative: {
              select: {
                slug: true,
                displayName: true,
                lifecycleState: true,
                activeVersionId: true,
                publicMode: true,
                runtimePolicyOverlays: {
                  where: { enabled: true },
                  select: {
                    enabled: true,
                    priority: true,
                    startsAt: true,
                    expiresAt: true,
                    payload: true,
                  },
                },
              },
            },
            channelBindings: {
              include: {
                representativeBinding: {
                  select: {
                    status: true,
                    desiredState: true,
                    healthStatus: true,
                    connectionId: true,
                    externalUserId: true,
                    telegramBotConnectionId: true,
                    endpointAssignmentRevision: true,
                    endpointLifecycleRevision: true,
                    telegramBotConnection: {
                      select: {
                        id: true,
                        botId: true,
                        status: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!run) {
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: { status: "DEAD_LETTER", lastError: "generation_run_not_found" },
      });
      return null;
    }
    if (run.status === GenerationRunStatus.CANCELED) {
      await releaseConversationEntitlementByGenerationRunId(
        {
          generationRunId: run.id,
          reason: "generation_run_canceled",
        },
        tx as unknown as ServiceEntitlementClient,
      );
      const walletReservation = readGenerationWalletReservation(
        run.runtimePolicySnapshot,
      );
      if (
        walletReservation
        && !delegationTaskOwnsGenerationBilling(run)
      ) {
        await releaseConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
            expectedGenerationRunId: run.id,
            failed: true,
            reason: "generation_run_canceled",
            idempotencyKey: `generation:${run.id}:release`,
          },
          tx as unknown as UsageChargeClient,
        );
      }
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
      return null;
    }
    let delegationTerminalRecovery:
      | ClaimedGenerationWorkItem["delegationTerminalRecovery"]
      | undefined;
    if (
      candidate.status === "PROCESSING"
      && run.status !== GenerationRunStatus.COMPLETED
      && run.delegationTaskStep?.externalEffects.length
    ) {
      await terminalizeExpiredGenerationLease(
        tx,
        run.id,
        outbox.id,
        {
          errorCode: DELEGATION_EXTERNAL_EFFECT_LEASE_LOST_ERROR,
          errorMessage:
            "The worker lease expired while an external effect may have reached the remote system.",
        },
      );
      return null;
    }
    const previousDelegationRunId =
      isJsonRecord(run.contextSnapshot)
      && run.contextSnapshot["source"] === "delegation_plan_step"
      && typeof run.contextSnapshot["previousGenerationRunId"] === "string"
        ? run.contextSnapshot["previousGenerationRunId"]
        : null;
    if (previousDelegationRunId) {
      const previousRun = await tx.generationRun.findUnique({
        where: { id: previousDelegationRunId },
        select: {
          status: true,
          outputMessage: {
            select: { deliveryStatus: true },
          },
        },
      });
      if (
        previousRun?.status !== GenerationRunStatus.COMPLETED
        || previousRun.outputMessage?.deliveryStatus
          !== MessageDeliveryStatus.SENT
      ) {
        await tx.outboxEvent.update({
          where: { id: outbox.id },
          data: {
            status: "PENDING",
            attemptCount: { decrement: 1 },
            availableAt: new Date(Date.now() + telegramWorkerOwnershipRetryMs),
            lastError: "delegation_previous_generation_not_completed",
          },
        });
        return null;
      }
    }
    if (
      run.status !== GenerationRunStatus.COMPLETED
      &&
      run.delegationTaskId
      && run.delegationTaskStep
      && isTerminalDelegationTaskStepStatus(
        run.delegationTaskStep.status,
      )
    ) {
      const latestStepRun = await tx.generationRun.findFirst({
        where: {
          delegationTaskId: run.delegationTaskId,
          delegationTaskStepId: run.delegationTaskStepId,
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (latestStepRun?.id === run.id) {
        delegationTerminalRecovery = {
          taskStatus: run.delegationTask?.status ?? "FAILED",
          stepStatus: run.delegationTaskStep.status,
          attachments: run.delegationTaskStep.outputs.flatMap((output) => {
            const artifact = output.artifact;
            if (!artifact) return [];
            return [{
              fileName: buildDelegationRecoveryArtifactFileName({
                artifactId: artifact.id,
                kind: artifact.kind,
                mimeType: artifact.mimeType,
              }),
              mimeType: artifact.mimeType,
              sizeBytes: artifact.sizeBytes,
              artifactId: artifact.id,
              url: `/reps/${encodeURIComponent(run.conversation.representative.slug)}/chat/artifacts/${encodeURIComponent(artifact.id)}/download`,
            }];
          }),
        };
      } else {
        const supersededAt = new Date();
        await tx.generationRun.update({
          where: { id: run.id },
          data: {
            status: GenerationRunStatus.CANCELED,
            errorCode: "delegation_step_already_finalized",
            errorMessage:
              "Generation was superseded after its delegation step advanced.",
            canceledAt: supersededAt,
          },
        });
        await tx.outboxEvent.update({
          where: { id: outbox.id },
          data: {
            status: "PROCESSED",
            processedAt: supersededAt,
            lastError: null,
          },
        });
        return null;
      }
    }
    if (
      run.status !== GenerationRunStatus.COMPLETED
      && (
        !run.representativeVersionId ||
        (
          run.episodeId
          && (
            !run.episode?.representativeVersionId
            || run.episode.representativeVersionId !== run.representativeVersionId
          )
        )
      )
    ) {
      const failedAt = new Date();
      const failureReason =
        "The generation run has no valid representative version pin or differs from its conversation episode.";
      await abortDelegatedTaskForGenerationClaimFailure(tx, run, failureReason);
      await releaseConversationEntitlementByGenerationRunId(
        {
          generationRunId: run.id,
          reason: "representative_version_context_mismatch",
        },
        tx as unknown as ServiceEntitlementClient,
      );
      await tx.generationRun.update({
        where: { id: run.id },
        data: {
          status: GenerationRunStatus.FAILED,
          errorCode: "representative_version_context_mismatch",
          errorMessage: failureReason,
          completedAt: failedAt,
        },
      });
      await tx.message.update({
        where: { id: run.inputMessageId },
        data: {
          deliveryStatus: MessageDeliveryStatus.FAILED,
          failureCode: "representative_version_context_mismatch",
          failureReason:
            "The generation run has no valid representative version pin or differs from its conversation episode.",
        },
      });
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: {
          status: "DEAD_LETTER",
          lastError: "representative_version_context_mismatch",
        },
      });
      const walletReservation = readGenerationWalletReservation(
        run.runtimePolicySnapshot,
      );
      if (
        walletReservation
        && !delegationTaskOwnsGenerationBilling(run)
      ) {
        await releaseConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
            expectedGenerationRunId: run.id,
            failed: true,
            reason: "representative_version_context_mismatch",
            idempotencyKey: `generation:${run.id}:release`,
          },
          tx as unknown as UsageChargeClient,
        );
      }
      return null;
    }

    const inputBinding = run.inputMessage.channelBinding;
    const matrixBinding = inputBinding?.kind === RepresentativeChannelKind.MATRIX
      ? inputBinding
      : run.conversation.channelBindings.find(
      (binding) => binding.kind === RepresentativeChannelKind.MATRIX,
      );
    const telegramBinding = inputBinding?.kind === RepresentativeChannelKind.TELEGRAM
      ? inputBinding
      : run.conversation.channelBindings.find(
      (binding) => binding.kind === RepresentativeChannelKind.TELEGRAM,
      );
    const channel = inputBinding
      ? inputBinding.kind === RepresentativeChannelKind.MATRIX
        ? "matrix"
        : inputBinding.kind === RepresentativeChannelKind.TELEGRAM
          ? "telegram"
          : "web"
      : matrixBinding
        ? "matrix"
        : telegramBinding
          ? "telegram"
          : "web";
    const activeBinding = channel === "matrix"
      ? matrixBinding
      : channel === "telegram"
        ? telegramBinding
        : inputBinding?.kind === RepresentativeChannelKind.WEB
          ? inputBinding
          : run.conversation.channelBindings.find(
              (binding) => binding.kind === RepresentativeChannelKind.WEB,
            );

    if (channel === "telegram" && options.telegramWorkerEnabled === false) {
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: {
          status: "PENDING",
          attemptCount: { decrement: 1 },
          availableAt: new Date(Date.now() + telegramWorkerOwnershipRetryMs),
          lastError: "telegram_worker_not_delivery_owner",
        },
      });
      return null;
    }

    if (channel === "matrix") {
      const currentLifecycleRevision =
        matrixBinding?.representativeBinding?.endpointLifecycleRevision;
      const matrixLifecycleCurrent =
        Number.isSafeInteger(run.inputMessage.channelLifecycleRevision)
        && (run.inputMessage.channelLifecycleRevision ?? 0) > 0
        && Number.isSafeInteger(currentLifecycleRevision)
        && (currentLifecycleRevision ?? 0) > 0
        && run.inputMessage.channelLifecycleRevision
          === currentLifecycleRevision;
      const matrixEndpointAvailability = matrixBinding
        ? resolveMatrixDeliveryEndpointAvailability({
            conversationRepresentativeMatrixUserId:
              readMatrixRepresentativeUserId(matrixBinding.metadata),
            representativeMatrixUserId:
              matrixBinding.representativeBinding?.externalUserId,
            conversationRepresentativeAssignmentRevision:
              matrixBinding.representativeAssignmentRevision,
            representativeAssignmentRevision:
              matrixBinding.representativeBinding
                ?.endpointAssignmentRevision,
          })
        : null;
      const matrixBindingSafe = matrixBinding
        ? await lockAndVerifyMatrixDirectBinding(tx, {
            id: matrixBinding.id,
            externalConversationId: matrixBinding.externalConversationId,
          })
        : false;
      if (
        matrixEndpointAvailability?.available === false
        || !matrixBindingSafe
        || !matrixLifecycleCurrent
      ) {
        const failureCode = matrixEndpointAvailability?.available === false
          ? matrixEndpointAvailability.code
          : !matrixBindingSafe
            ? "matrix_private_room_not_verified"
            : "matrix_channel_lifecycle_reactivated";
        const failureReason =
          matrixEndpointAvailability?.available === false
            ? "Generation canceled because the Matrix room belongs to a previously assigned representative identity."
            : !matrixBindingSafe
            ? "Generation canceled because the Matrix room is no longer a verified private conversation."
            : "Generation canceled because it belongs to an earlier Matrix channel activation.";
        await abortDelegatedTaskForGenerationClaimFailure(
          tx,
          run,
          failureReason,
        );
        await releaseConversationEntitlementByGenerationRunId(
          {
            generationRunId: run.id,
            reason: failureCode,
          },
          tx as unknown as ServiceEntitlementClient,
        );
        if (run.status === GenerationRunStatus.COMPLETED) {
          if (run.outputMessage) {
            await tx.message.update({
              where: { id: run.outputMessage.id },
              data: {
                deliveryStatus: MessageDeliveryStatus.CANCELED,
                failureCode,
                failureReason:
                  matrixEndpointAvailability?.available === false
                    ? "Matrix delivery was canceled because this room belongs to a previously assigned representative identity."
                    : !matrixBindingSafe
                    ? "Matrix delivery was canceled because the room is no longer a verified private conversation."
                    : "Matrix delivery was canceled because it belongs to an earlier channel activation.",
              },
            });
          }
        } else {
          const walletReservation = readGenerationWalletReservation(
            run.runtimePolicySnapshot,
          );
          if (
            walletReservation
            && !delegationTaskOwnsGenerationBilling(run)
          ) {
            await releaseConversationWalletUsage(
              {
                usageChargeId: walletReservation.usageChargeId,
                expectedGenerationRunId: run.id,
                failed: true,
                reason: failureCode,
                idempotencyKey: `generation:${run.id}:release`,
              },
              tx as unknown as UsageChargeClient,
            );
          }
          const canceledAt = new Date();
          await tx.generationRun.update({
            where: { id: run.id },
            data: {
              status: GenerationRunStatus.CANCELED,
              errorCode: failureCode,
              errorMessage: failureReason,
              canceledAt,
            },
          });
          await tx.message.update({
            where: { id: run.inputMessageId },
            data: {
              deliveryStatus: MessageDeliveryStatus.CANCELED,
              failureCode,
              failureReason:
                matrixEndpointAvailability?.available === false
                  ? "The Matrix room belongs to a previously assigned representative identity."
                  : !matrixBindingSafe
                  ? "The Matrix room is no longer a verified private conversation."
                  : "The request belongs to an earlier Matrix channel activation.",
            },
          });
        }
        await tx.outboxEvent.update({
          where: { id: outbox.id },
          data: { status: "DEAD_LETTER", lastError: failureCode },
        });
        return null;
      }
    }

    if (run.status === GenerationRunStatus.COMPLETED) {
      if (!run.outputMessage?.text) {
        await tx.outboxEvent.update({
          where: { id: outbox.id },
          data: {
            status: "DEAD_LETTER",
            lastError: "completed_generation_output_missing",
          },
        });
        return null;
      }
      if (channel === "web" || run.outputMessage.externalMessageId) {
        await tx.message.update({
          where: { id: run.outputMessage.id },
          data: {
            deliveryStatus: MessageDeliveryStatus.SENT,
            failureCode: null,
            failureReason: null,
          },
        });
        await tx.outboxEvent.update({
          where: { id: outbox.id },
          data: {
            status: "PROCESSED",
            processedAt: new Date(),
            lastError: null,
          },
        });
        return null;
      }
    }

    const availability = resolveChannelAvailability({
      channel,
      lifecycleState: run.conversation.representative.lifecycleState,
      activeVersionId: run.conversation.representative.activeVersionId,
      publicMode: run.conversation.representative.publicMode,
      binding: activeBinding
        ? activeBinding.representativeBinding
          ? {
              legacyStatus: activeBinding.representativeBinding.status,
              desiredState: activeBinding.representativeBinding.desiredState,
              healthStatus: activeBinding.representativeBinding.healthStatus,
            }
          : channel === "web"
            ? {
                legacyStatus: "CONNECTED",
                desiredState: "ACTIVE",
                healthStatus: "UNKNOWN",
              }
            : null
        : null,
      ...(channel === "telegram" && activeBinding
        ? {
            telegramEndpoint: {
              conversationConnectionId: activeBinding.connectionId,
              representativeConnectionId:
                activeBinding.representativeBinding?.connectionId,
              conversationRepresentativeAssignmentRevision:
                activeBinding.representativeAssignmentRevision,
              representativeAssignmentRevision:
                activeBinding.representativeBinding
                  ?.endpointAssignmentRevision,
              ...(outbox.connectionId?.trim()
                ? { expectedConnectionId: outbox.connectionId }
                : {}),
              representativeTelegramBotConnectionId:
                activeBinding.representativeBinding?.telegramBotConnectionId,
              representativeTelegramBot:
                activeBinding.representativeBinding?.telegramBotConnection,
            },
          }
        : {}),
      ...(channel === "matrix" && activeBinding
        ? {
            matrixEndpoint: {
              conversationRepresentativeMatrixUserId:
                readMatrixRepresentativeUserId(activeBinding.metadata),
              representativeMatrixUserId:
                activeBinding.representativeBinding?.externalUserId,
              conversationRepresentativeAssignmentRevision:
                activeBinding.representativeAssignmentRevision,
              representativeAssignmentRevision:
                activeBinding.representativeBinding
                  ?.endpointAssignmentRevision,
            },
          }
        : {}),
      overlays: (run.conversation.representative.runtimePolicyOverlays ?? []).map((overlay) => ({
        ...overlay,
        payload: isJsonRecord(overlay.payload) ? overlay.payload : {},
      })),
    });
    if (!availability.available) {
      if (run.status === GenerationRunStatus.COMPLETED) {
        if (
          availability.code === "telegram_connection_reassigned"
          || availability.code === "matrix_identity_reassigned"
        ) {
          const identityReassigned =
            availability.code === "matrix_identity_reassigned";
          if (run.outputMessage) {
            await tx.message.update({
              where: { id: run.outputMessage.id },
              data: {
                deliveryStatus: MessageDeliveryStatus.CANCELED,
                failureCode: availability.code,
                failureReason:
                  identityReassigned
                    ? "Matrix delivery was canceled because this room belongs to a previously assigned representative identity."
                    : "Telegram delivery was canceled because this conversation belongs to a previously assigned Bot.",
              },
            });
          }
          await tx.outboxEvent.update({
            where: { id: outbox.id },
            data: {
              status: "DEAD_LETTER",
              lastError: availability.code,
            },
          });
          return null;
        }
        await tx.outboxEvent.update({
          where: { id: outbox.id },
          data: {
            status: "FAILED",
            attemptCount: { decrement: 1 },
            availableAt: new Date(Date.now() + telegramWorkerOwnershipRetryMs),
            lastError: availability.code,
          },
        });
        return null;
      }
      const canceledAt = new Date();
      const failureReason =
        availability.code === "telegram_connection_reassigned"
          ? "Generation canceled because this Telegram conversation belongs to a previously assigned Bot."
          : availability.code === "matrix_identity_reassigned"
            ? "Generation canceled because this Matrix room belongs to a previously assigned representative identity."
          : `Generation canceled because ${availability.code}.`;
      await abortDelegatedTaskForGenerationClaimFailure(
        tx,
        run,
        failureReason,
      );
      await releaseConversationEntitlementByGenerationRunId(
        {
          generationRunId: run.id,
          reason: availability.code,
        },
        tx as unknown as ServiceEntitlementClient,
      );
      const walletReservation = readGenerationWalletReservation(
        run.runtimePolicySnapshot,
      );
      if (
        walletReservation
        && !delegationTaskOwnsGenerationBilling(run)
      ) {
        await releaseConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
            expectedGenerationRunId: run.id,
            failed: true,
            reason: availability.code,
            idempotencyKey: `generation:${run.id}:release`,
          },
          tx as unknown as UsageChargeClient,
        );
      }
      await tx.generationRun.update({
        where: { id: run.id },
        data: {
          status: GenerationRunStatus.CANCELED,
          errorCode: availability.code,
          errorMessage: failureReason,
          canceledAt,
        },
      });
      await tx.message.update({
        where: { id: run.inputMessageId },
        data: {
          deliveryStatus: MessageDeliveryStatus.CANCELED,
          failureCode: availability.code,
          failureReason:
            availability.code === "telegram_connection_reassigned"
              ? "This Telegram conversation belongs to a previously assigned Bot."
              : availability.code === "matrix_identity_reassigned"
                ? "This Matrix room belongs to a previously assigned representative identity."
              : "The channel is not currently available.",
        },
      });
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: { status: "DEAD_LETTER", lastError: availability.code },
      });
      return null;
    }
    const matrixVirtualUser = channel === "matrix"
      ? await tx.matrixVirtualUserBinding.findFirst({
          where: {
            representativeId: run.conversation.representativeId,
            kind: "REPRESENTATIVE",
            enabled: true,
          },
          select: { matrixUserId: true },
        })
      : null;
    const walletReservation = readGenerationWalletReservation(
      run.runtimePolicySnapshot,
    );
    const telegramConnectionId =
      channel === "telegram"
        ? activeBinding?.representativeBinding?.connectionId || null
        : null;

    if (run.status !== GenerationRunStatus.COMPLETED) {
      await tx.generationRun.update({
        where: { id: run.id },
        data: {
          status: GenerationRunStatus.PROCESSING,
          startedAt: run.startedAt || new Date(),
          attemptCount: { increment: 1 },
        },
      });
      await tx.message.update({
        where: { id: run.inputMessageId },
        data: { deliveryStatus: MessageDeliveryStatus.PROCESSING },
      });
    }

    return {
      outboxId: outbox.id,
      leaseAttempt: outbox.attemptCount,
      runId: run.id,
      ...(run.delegationTaskId ? { delegationTaskId: run.delegationTaskId } : {}),
      ...(run.delegationTaskStepId ? { delegationTaskStepId: run.delegationTaskStepId } : {}),
      ...(run.contextSnapshot !== null ? { contextSnapshot: run.contextSnapshot } : {}),
      representativeVersionId: run.representativeVersionId,
      representativeSlug: run.conversation.representative.slug,
      representativeName: run.conversation.representative.displayName,
      conversationId: run.conversationId,
      contactId: run.conversation.contactId,
      ...(run.conversation.audienceIdentityId
        ? { audienceIdentityId: run.conversation.audienceIdentityId }
        : {}),
      controlState: run.conversation.state,
      ...(run.episodeId ? { episodeId: run.episodeId } : {}),
      inputMessageId: run.inputMessageId,
      userText: run.inputMessage.text || "",
      ...(run.inputMessage.senderId
        ? { sourceSenderId: run.inputMessage.senderId }
        : {}),
      ...(activeBinding?.connectionId
        ? { privateChannelConnectionId: activeBinding.connectionId }
        : {}),
      channel,
      ...(activeBinding
        ? { externalConversationId: activeBinding.externalConversationId }
        : {}),
      ...(telegramConnectionId
        ? { telegramConnectionId }
        : {}),
      ...(matrixVirtualUser ? { matrixSenderUserId: matrixVirtualUser.matrixUserId } : {}),
      ...(
        channel === "matrix"
        && Number.isSafeInteger(run.inputMessage.channelLifecycleRevision)
        && (run.inputMessage.channelLifecycleRevision ?? 0) > 0
          ? {
              matrixEndpointLifecycleRevision:
                run.inputMessage.channelLifecycleRevision!,
            }
          : {}
      ),
      ...(run.status === GenerationRunStatus.COMPLETED && run.outputMessage
        ? {
            deliveryOnly: true,
            outputMessageId: run.outputMessage.id,
            outputText: run.outputMessage.text!,
          }
        : {}),
      ...(delegationTerminalRecovery
        ? { delegationTerminalRecovery }
        : {}),
      ...(walletReservation ? { walletReservation } : {}),
      usage: {
        freeRepliesUsed: run.conversation.freeRepliesUsed,
        passUnlocked:
          Boolean(run.conversation.passUnlockedAt)
          || Boolean(walletReservation),
        deepHelpUnlocked: Boolean(run.conversation.deepHelpUnlockedAt),
      },
    };
  });
}

function buildDelegationRecoveryArtifactFileName(input: {
  artifactId: string;
  kind: string;
  mimeType: string;
}) {
  const extension = input.mimeType.includes("json")
    ? "json"
    : input.mimeType.includes("csv")
      ? "csv"
      : input.mimeType.includes("png")
        ? "png"
        : input.mimeType.includes("jpeg")
          ? "jpg"
          : input.mimeType.includes("pdf")
            ? "pdf"
            : "txt";
  return `${input.kind.toLowerCase()}-${input.artifactId}.${extension}`;
}

async function abortDelegatedTaskForGenerationClaimFailure(
  tx: Prisma.TransactionClient,
  run: {
    id: string;
    delegationTaskId?: string | null;
    delegationTaskStepId?: string | null;
  },
  failureReason: string,
) {
  if (!run.delegationTaskId) return null;
  const {
    abortDelegationTaskForGenerationFailureInTransaction,
  } = await import("./delegation-tasks");
  return abortDelegationTaskForGenerationFailureInTransaction(tx, {
    taskId: run.delegationTaskId,
    generationRunId: run.id,
    ...(run.delegationTaskStepId
      ? { stepId: run.delegationTaskStepId }
      : {}),
    failureReason,
  });
}

/**
 * Extend a claimed work item's visibility lease.
 *
 * `attemptCount` fences stale workers: once another worker reclaims the row,
 * the older attempt can no longer renew it.
 */
export async function renewGenerationWorkItemLease(input: {
  outboxId: string;
  leaseAttempt: number;
}): Promise<boolean> {
  const leaseExpiresAt = new Date(
    Date.now() + GENERATION_WORK_LEASE_DURATION_MS,
  );
  const renewed = await prisma.outboxEvent.updateMany({
    where: {
      id: input.outboxId,
      status: "PROCESSING",
      attemptCount: input.leaseAttempt,
    },
    data: { availableAt: leaseExpiresAt },
  });
  return renewed.count === 1;
}

async function terminalizeExpiredGenerationLease(
  tx: Prisma.TransactionClient,
  runId: string,
  outboxId: string,
  options: {
    errorCode?: string;
    errorMessage?: string;
    recoverLatestTerminalDelegationResult?: boolean;
  } = {},
) {
  const now = new Date();
  const errorCode =
    options.errorCode ?? GENERATION_WORK_LEASE_EXHAUSTED_ERROR;
  const errorMessage =
    options.errorMessage
    ?? "The conversation worker stopped renewing its lease and exhausted all retry attempts.";
  const run = await tx.generationRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      inputMessageId: true,
      outputMessageId: true,
      conversationId: true,
      episodeId: true,
      delegationTaskId: true,
      delegationTaskStepId: true,
      runtimePolicySnapshot: true,
    },
  });
  if (!run) {
    await tx.outboxEvent.update({
      where: { id: outboxId },
      data: {
        status: "DEAD_LETTER",
        lastError: "generation_run_not_found",
      },
    });
    return;
  }
  if (run.status === GenerationRunStatus.COMPLETED) {
    if (run.outputMessageId) {
      await tx.message.updateMany({
        where: {
          id: run.outputMessageId,
          deliveryStatus: {
            in: [
              MessageDeliveryStatus.QUEUED,
              MessageDeliveryStatus.PROCESSING,
              MessageDeliveryStatus.FAILED,
            ],
          },
        },
        data: {
          deliveryStatus: MessageDeliveryStatus.FAILED,
          failureCode: GENERATION_WORK_LEASE_EXHAUSTED_ERROR,
          failureReason:
            "The channel delivery worker exhausted all retry attempts.",
        },
      });
    }
    await tx.outboxEvent.update({
      where: { id: outboxId },
      data: {
        status: "DEAD_LETTER",
        lastError: GENERATION_WORK_LEASE_EXHAUSTED_ERROR,
      },
    });
    return;
  }
  if (run.status === GenerationRunStatus.CANCELED) {
    await tx.outboxEvent.update({
      where: { id: outboxId },
      data: {
        status: "PROCESSED",
        processedAt: now,
        lastError: null,
      },
    });
    return;
  }
  if (run.delegationTaskId && run.delegationTaskStepId) {
    const step = await tx.delegationTaskStep.findUnique({
      where: { id: run.delegationTaskStepId },
      select: { status: true },
    });
    if (
      step
      && isTerminalDelegationTaskStepStatus(step.status)
    ) {
      if (options.recoverLatestTerminalDelegationResult) {
        const latestStepRun = await tx.generationRun.findFirst({
          where: {
            delegationTaskId: run.delegationTaskId,
            delegationTaskStepId: run.delegationTaskStepId,
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (latestStepRun?.id === run.id) {
          await tx.outboxEvent.update({
            where: { id: outboxId },
            data: {
              status: "PROCESSED",
              processedAt: now,
              lastError: null,
            },
          });
          await tx.outboxEvent.create({
            data: {
              conversationId: run.conversationId,
              aggregateType: "generation_run",
              aggregateId: run.id,
              eventType: "generation.requested",
              payload: {
                runId: run.id,
                conversationId: run.conversationId,
                messageId: run.inputMessageId,
                recoveryOfOutboxId: outboxId,
              },
              status: "PENDING",
              attemptCount: 0,
              idempotencyKey:
                `generation.requested:${run.id}:recovery:${outboxId}`,
            },
          });
          return;
        }
      }
      await tx.generationRun.update({
        where: { id: run.id },
        data: {
          status: GenerationRunStatus.CANCELED,
          errorCode: "delegation_step_already_finalized",
          errorMessage:
            "Generation was superseded after its delegation step advanced.",
          canceledAt: now,
        },
      });
      await tx.outboxEvent.update({
        where: { id: outboxId },
        data: {
          status: "PROCESSED",
          processedAt: now,
          lastError: null,
        },
      });
      return;
    }
  }

  const executionReference =
    run.delegationTaskId
      ? await tx.toolExecution.findUnique({
          where: { generationOutboxId: outboxId },
          select: { id: true },
        })
      : null;
  if (executionReference) {
    await tx.$executeRaw`
      SELECT "id"
      FROM "ToolExecution"
      WHERE "id" = ${executionReference.id}
      FOR UPDATE
    `;
  }
  const inFlightExecution =
    executionReference
      ? await tx.toolExecution.findUnique({
          where: { id: executionReference.id },
          select: {
            id: true,
            sessionId: true,
            status: true,
            delegationTaskId: true,
            delegationTaskStepId: true,
            session: {
              select: {
                generationRunId: true,
              },
            },
          },
        })
      : null;
  const executionMatchesGeneration = Boolean(
    inFlightExecution
    && inFlightExecution.delegationTaskId === run.delegationTaskId
    && inFlightExecution.delegationTaskStepId
      === run.delegationTaskStepId
    && inFlightExecution.session.generationRunId === run.id,
  );
  if (
    inFlightExecution
    && executionMatchesGeneration
    && inFlightExecution.status !== "RUNNING"
  ) {
    await tx.outboxEvent.update({
      where: { id: outboxId },
      data: {
        status: "PENDING",
        attemptCount: 0,
        availableAt: now,
        processedAt: null,
        lastError: "generation_execution_replay_pending",
      },
    });
    return;
  }
  const fencedInFlightExecution =
    inFlightExecution && executionMatchesGeneration
      ? await tx.toolExecution.updateMany({
          where: {
            id: inFlightExecution.id,
            status: "RUNNING",
          },
          data: {
            status: "FAILED",
            finishedAt: now,
            executionLeaseToken: null,
          },
        })
      : { count: 0 };
  if (fencedInFlightExecution.count === 1 && inFlightExecution) {
    await tx.computeSession.updateMany({
      where: { id: inFlightExecution.sessionId },
      data: {
        status: "IDLE",
        failureReason: "generation_execution_result_unknown",
        lastHeartbeatAt: now,
      },
    });
  }

  await tx.generationRun.update({
    where: { id: run.id },
    data: {
      status: GenerationRunStatus.FAILED,
      errorCode,
      errorMessage,
      completedAt: now,
    },
  });
  await tx.message.update({
    where: { id: run.inputMessageId },
    data: {
      deliveryStatus: MessageDeliveryStatus.FAILED,
      failureCode: errorCode,
      failureReason: errorMessage,
    },
  });
  await tx.conversation.updateMany({
    where: {
      id: run.conversationId,
      state: { notIn: ["HUMAN_ACTIVE", "NEEDS_HUMAN"] },
    },
    data: { state: "FAILED" },
  });
  if (run.episodeId) {
    await tx.conversationEpisode.updateMany({
      where: {
        id: run.episodeId,
        status: {
          in: [
            ConversationEpisodeStatus.ACTIVE,
            ConversationEpisodeStatus.WAITING_APPROVAL,
          ],
        },
      },
      data: { status: ConversationEpisodeStatus.FAILED },
    });
  }
  await tx.outboxEvent.update({
    where: { id: outboxId },
    data: {
      status: "DEAD_LETTER",
      lastError: errorCode,
    },
  });

  let delegatedExecutionRequiresReconciliation =
    fencedInFlightExecution.count === 1;
  if (run.delegationTaskId) {
    const uncertainEffects =
      await tx.delegationTaskExternalEffect.updateMany({
        where: {
          delegationTaskId: run.delegationTaskId,
          ...(run.delegationTaskStepId
            ? { delegationTaskStepId: run.delegationTaskStepId }
            : {}),
          status: "EXECUTING",
        },
        data: {
          status: "RECONCILIATION_REQUIRED",
          failureReason: errorCode,
        },
      });
    if (
      uncertainEffects.count > 0
      || delegatedExecutionRequiresReconciliation
    ) {
      delegatedExecutionRequiresReconciliation = true;
      await tx.delegationTask.updateMany({
        where: {
          id: run.delegationTaskId,
          status: {
            notIn: [
              DelegationTaskStatus.COMPLETED,
              DelegationTaskStatus.FAILED,
              DelegationTaskStatus.CANCELED,
              DelegationTaskStatus.EXPIRED,
            ],
          },
        },
        data: {
          status: DelegationTaskStatus.WAITING_FOR_OWNER,
          nextActionBy: DelegationTaskNextActor.OWNER,
          blockingReason:
            uncertainEffects.count > 0
              ? "Worker lease expired during an external effect. Reconcile the remote outcome before continuing."
              : "Worker lease expired while compute execution was still in flight. Review the unknown result before continuing.",
        },
      });
    } else {
      await tx.delegationTask.updateMany({
        where: {
          id: run.delegationTaskId,
          status: {
            notIn: [
              DelegationTaskStatus.COMPLETED,
              DelegationTaskStatus.FAILED,
              DelegationTaskStatus.CANCELED,
              DelegationTaskStatus.EXPIRED,
            ],
          },
        },
        data: {
          status: DelegationTaskStatus.FAILED,
          nextActionBy: DelegationTaskNextActor.OWNER,
          blockingReason:
            "The worker lease expired before the delegated task could finish.",
          failedAt: now,
        },
      });
      if (run.delegationTaskStepId) {
        await tx.delegationTaskStep.updateMany({
          where: {
            id: run.delegationTaskStepId,
            status: {
              notIn: [
                DelegationTaskStepStatus.COMPLETED,
                DelegationTaskStepStatus.FAILED,
                DelegationTaskStepStatus.CANCELED,
                DelegationTaskStepStatus.SKIPPED,
              ],
            },
          },
          data: {
            status: DelegationTaskStepStatus.FAILED,
            failedAt: now,
          },
        });
      }
    }
  }

  if (!delegatedExecutionRequiresReconciliation) {
    await releaseConversationEntitlementByGenerationRunId(
      {
        generationRunId: run.id,
        reason: errorCode,
      },
      tx as unknown as ServiceEntitlementClient,
    );
  }
  const walletReservation = readGenerationWalletReservation(
    run.runtimePolicySnapshot,
  );
  if (walletReservation && !delegatedExecutionRequiresReconciliation) {
    await releaseConversationWalletUsage(
      {
        usageChargeId: walletReservation.usageChargeId,
        expectedGenerationRunId: run.id,
        failed: true,
        reason: errorCode,
        idempotencyKey: `generation:${run.id}:release`,
      },
      tx as unknown as UsageChargeClient,
    );
  }
}

export async function loadGenerationRecentTurns(input: {
  representativeId: string;
  conversationId: string;
  beforeMessageId: string;
  limit?: number;
}) {
  const [before, policy] = await Promise.all([
    prisma.message.findUnique({
      where: { id: input.beforeMessageId },
      select: { createdAt: true, episodeId: true },
    }),
    prisma.representativeMemoryPolicy.findUnique({
      where: { representativeId: input.representativeId },
      select: { shortTermMemoryEnabled: true },
    }),
  ]);

  // Short-term context historically existed before it became configurable.
  // A missing policy therefore preserves the existing same-episode behavior,
  // while an explicit false value fails closed to the current message only.
  if (policy?.shortTermMemoryEnabled === false || !before?.episodeId) {
    return [];
  }

  const rows = await prisma.message.findMany({
    where: {
      conversationId: input.conversationId,
      episodeId: before.episodeId,
      redactedAt: null,
      text: { not: null },
      createdAt: { lt: before.createdAt },
      // Outbound replies can contain facts injected from a source that has
      // since been disabled or deleted. Re-injecting that text as an
      // unclassified recent turn would bypass the new generation's UseRun
      // and defeat immediate recall revocation. Keep only audience-authored
      // short-term context; every system/representative fact must be
      // re-authorized through the current generation ledger.
      senderType: MessageSenderType.AUDIENCE,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit || 10,
    select: { senderType: true, text: true },
  });
  return rows.reverse().map((message) => ({
    direction: "inbound" as const,
    messageText: message.text || "",
  }));
}

export async function deferGenerationRunForHuman(input: {
  runId: string;
  outboxId: string;
  leaseAttempt: number;
}) {
  return runConversationWriteTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.runId}))`;
    await fenceGenerationWorkLease(tx, input);
    const current = await tx.generationRun.findUnique({
      where: { id: input.runId },
      include: {
        delegationTaskStep: {
          select: { kind: true },
        },
      },
    });
    if (!current) throw new Error("Generation run not found.");
    if (
      current.status === GenerationRunStatus.COMPLETED ||
      current.status === GenerationRunStatus.CANCELED
    ) {
      return current;
    }

    await releaseConversationEntitlementByGenerationRunId(
      {
        generationRunId: input.runId,
        reason: "generation_deferred_for_human",
      },
      tx as unknown as ServiceEntitlementClient,
    );
    const walletReservation = readGenerationWalletReservation(
      current.runtimePolicySnapshot,
    );
    let releasedSnapshot: Prisma.InputJsonObject | null = null;
    if (
      walletReservation
      && !delegationTaskOwnsGenerationBilling(current)
    ) {
      await releaseConversationWalletUsage(
        {
          usageChargeId: walletReservation.usageChargeId,
          expectedGenerationRunId: current.id,
          reason: "generation_deferred_to_human",
          idempotencyKey: `generation:${current.id}:release`,
        },
        tx as unknown as UsageChargeClient,
      );
      releasedSnapshot = markGenerationWalletReleased(
        current.runtimePolicySnapshot,
        new Date(),
      );
    }
    const run = await tx.generationRun.update({
      where: { id: input.runId },
      data: {
        status: GenerationRunStatus.WAITING_HUMAN,
        ...(releasedSnapshot
          ? { runtimePolicySnapshot: releasedSnapshot }
          : {}),
      },
    });
    const completedOutbox = await tx.outboxEvent.updateMany({
      where: {
        id: input.outboxId,
        aggregateType: "generation_run",
        aggregateId: run.id,
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: input.leaseAttempt,
      },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    if (completedOutbox.count !== 1) {
      throw new GenerationWorkLeaseLostError(
        input.outboxId,
        input.leaseAttempt,
      );
    }
    return run;
  });
}

export async function markGenerationDeliveryComplete(input: {
  runId: string;
  outboxId: string;
  leaseAttempt: number;
  outputMessageId: string;
  externalMessageId?: string;
}) {
  await runConversationWriteTransaction(async (tx) => {
    await fenceGenerationWorkLease(tx, input);
    await tx.message.update({
      where: { id: input.outputMessageId },
      data: {
        deliveryStatus: MessageDeliveryStatus.SENT,
        ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
      },
    });
    const completedOutbox = await tx.outboxEvent.updateMany({
      where: {
        id: input.outboxId,
        aggregateType: "generation_run",
        aggregateId: input.runId,
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: input.leaseAttempt,
      },
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
    });
    if (completedOutbox.count !== 1) {
      throw new GenerationWorkLeaseLostError(
        input.outboxId,
        input.leaseAttempt,
      );
    }
  });
}

export type GenerationMessageDeliveryFenceInput = {
  conversationId: string;
  runId: string;
  outboxId: string;
  leaseAttempt: number;
  outputMessageId: string;
};

async function revalidateGenerationMessageMemoryDeliveryInTransaction(
  tx: Prisma.TransactionClient,
  input: GenerationMessageDeliveryFenceInput,
) {
  const memoryDelivery = await revalidateMemoryUseDeliverySourcesInTransaction(
    tx,
    {
      generationRunId: input.runId,
      conversationId: input.conversationId,
      outputMessageId: input.outputMessageId,
    },
  );
  if (memoryDelivery.authorized) return true;

  const canceledAt = new Date();
  const canceled = await tx.message.updateMany({
    where: {
      id: input.outputMessageId,
      conversationId: input.conversationId,
      senderType: MessageSenderType.REPRESENTATIVE,
      deliveryStatus: {
        in: [
          MessageDeliveryStatus.QUEUED,
          MessageDeliveryStatus.PROCESSING,
          MessageDeliveryStatus.FAILED,
        ],
      },
    },
    data: {
      deliveryStatus: MessageDeliveryStatus.CANCELED,
      failureCode: GENERATION_MEMORY_DELIVERY_BLOCKED_ERROR,
      failureReason:
        "Delivery canceled because an injected source is no longer authorized.",
    },
  });
  const deadLettered = await tx.outboxEvent.updateMany({
    where: {
      id: input.outboxId,
      aggregateType: "generation_run",
      aggregateId: input.runId,
      eventType: "generation.requested",
      status: "PROCESSING",
      attemptCount: input.leaseAttempt,
    },
    data: {
      status: "DEAD_LETTER",
      processedAt: canceledAt,
      lastError: GENERATION_MEMORY_DELIVERY_BLOCKED_ERROR,
    },
  });
  if (canceled.count !== 1 || deadLettered.count !== 1) {
    throw new GenerationWorkLeaseLostError(
      input.outboxId,
      input.leaseAttempt,
    );
  }
  return false;
}

/**
 * Holds the contact + representative + channel memory coordinate fence across
 * the final provider side effect. Forget/delete uses the same advisory lock,
 * so either deletion commits first and this delivery is canceled, or the
 * provider side effect completes before deletion is allowed to commit.
 */
export async function withGenerationMessageProviderDeliveryFence<T>(
  tx: Prisma.TransactionClient,
  input: GenerationMessageDeliveryFenceInput,
  operation: () => Promise<T>,
): Promise<
  | { executed: true; value: T }
  | { executed: false; reason: "memory_delivery_source_revoked" }
> {
  await fenceGenerationWorkLease(tx, input);
  const authorized =
    await revalidateGenerationMessageMemoryDeliveryInTransaction(tx, input);
  if (!authorized) {
    return {
      executed: false,
      reason: "memory_delivery_source_revoked",
    };
  }
  return { executed: true, value: await operation() };
}

export async function prepareGenerationMessageChannelDelivery(input: {
  conversationId: string;
  runId: string;
  outboxId: string;
  leaseAttempt: number;
  outputMessageId: string;
}) {
  const outcome = await runConversationWriteTransaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))
    `;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.runId}))
    `;
    await fenceGenerationWorkLease(tx, input);
    const conversation = await tx.conversation.findUnique({
      where: { id: input.conversationId },
      select: { state: true },
    });
    if (!conversation) throw new Error("Conversation not found.");
    const run = await tx.generationRun.findUnique({
      where: { id: input.runId },
      select: {
        conversationId: true,
        outputMessageId: true,
        outputMessage: {
          select: { content: true },
        },
      },
    });
    if (
      !run
      || run.conversationId !== input.conversationId
      || run.outputMessageId !== input.outputMessageId
    ) {
      throw new GenerationWorkLeaseLostError(
        input.outboxId,
        input.leaseAttempt,
      );
    }
    const memoryDeliveryAuthorized =
      await revalidateGenerationMessageMemoryDeliveryInTransaction(tx, input);
    if (!memoryDeliveryAuthorized) {
      return { blocked: true as const };
    }
    const allowNeedsHumanDelivery =
      isNeedsHumanDeliveryAuthorized(
        run.outputMessage?.content,
        input.runId,
      );
    if (
      conversation.state === "HUMAN_ACTIVE"
      || (
        conversation.state === "NEEDS_HUMAN"
        && !allowNeedsHumanDelivery
      )
    ) {
      throw new ConversationAiDeliveryControlError();
    }
    const prepared = await tx.message.updateMany({
      where: {
        id: input.outputMessageId,
        deliveryStatus: {
          in: [
            MessageDeliveryStatus.QUEUED,
            MessageDeliveryStatus.PROCESSING,
            MessageDeliveryStatus.FAILED,
          ],
        },
      },
      data: {
        deliveryStatus: MessageDeliveryStatus.PROCESSING,
        failureCode: null,
        failureReason: null,
      },
    });
    if (prepared.count !== 1) {
      throw new GenerationWorkLeaseLostError(
        input.outboxId,
        input.leaseAttempt,
      );
    }
    const renewed = await tx.outboxEvent.updateMany({
      where: {
        id: input.outboxId,
        status: "PROCESSING",
        attemptCount: input.leaseAttempt,
      },
      data: {
        availableAt: new Date(
          Date.now() + GENERATION_WORK_LEASE_DURATION_MS,
        ),
      },
    });
    if (renewed.count !== 1) {
      throw new GenerationWorkLeaseLostError(
        input.outboxId,
        input.leaseAttempt,
      );
    }
    return {
      blocked: false as const,
      preparation: {
        conversationState: conversation.state,
        allowNeedsHumanDelivery,
        leaseExpiresAt: new Date(
          Date.now() + GENERATION_WORK_LEASE_DURATION_MS,
        ),
      },
    };
  });
  if (outcome.blocked) {
    // Throw only after the transaction commits the cancel/dead-letter writes.
    // Throwing inside the transaction would roll back the delivery fence.
    throw new GenerationMemoryDeliveryBlockedError();
  }
  return outcome.preparation;
}

export async function retryGenerationDelivery(input: {
  runId: string;
  outboxId: string;
  leaseAttempt: number;
  outputMessageId?: string;
  errorMessage: string;
}) {
  const deadLetter = input.leaseAttempt >= GENERATION_WORK_MAX_ATTEMPTS;
  await runConversationWriteTransaction(async (tx) => {
    await fenceGenerationWorkLease(tx, input);
    if (input.outputMessageId) {
      await tx.message.update({
        where: { id: input.outputMessageId },
        data: {
          deliveryStatus: MessageDeliveryStatus.FAILED,
          failureCode: "channel_delivery_failed",
          failureReason: input.errorMessage,
        },
      });
    }
    const failedOutbox = await tx.outboxEvent.updateMany({
      where: {
        id: input.outboxId,
        aggregateType: "generation_run",
        aggregateId: input.runId,
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: input.leaseAttempt,
      },
      data: {
        status: deadLetter ? "DEAD_LETTER" : "FAILED",
        lastError: input.errorMessage,
        availableAt: new Date(Date.now() + Math.min(60_000, 2 ** input.leaseAttempt * 1000)),
      },
    });
    if (failedOutbox.count !== 1) {
      throw new GenerationWorkLeaseLostError(
        input.outboxId,
        input.leaseAttempt,
      );
    }
  });
}

export type ClaimedOperatorMessageWorkItem = {
  outboxId: string;
  messageId: string;
  conversationId: string;
  text: string;
  operatorName: string;
  channel: "matrix" | "telegram";
  externalConversationId: string;
  telegramConnectionId?: string;
  matrixSenderUserId?: string;
  matrixEndpointLifecycleRevision?: number;
};

export async function claimNextOperatorMessageWorkItem(
  options: {
    telegramWorkerEnabled?: boolean;
    processingLeaseMs?: number;
  } = {},
): Promise<ClaimedOperatorMessageWorkItem | null> {
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<Array<{
      id: string;
      aggregateId: string;
      attemptCount: number;
    }>>`
      SELECT "id", "aggregateId", "attemptCount"
      FROM "OutboxEvent"
      WHERE "status" IN ('PENDING', 'FAILED', 'PROCESSING')
        AND "eventType" = 'operator.message.requested'
        AND "availableAt" <= NOW()
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const candidate = candidates[0];
    const outboxId = candidate?.id;
    if (!outboxId) return null;
    if ((candidate.attemptCount ?? 0) >= 5) {
      await tx.message.updateMany({
        where: { id: candidate.aggregateId },
        data: {
          deliveryStatus: MessageDeliveryStatus.FAILED,
          failureCode: "operator_channel_delivery_attempts_exhausted",
          failureReason: "Operator message delivery exhausted its retry budget.",
        },
      });
      await tx.outboxEvent.update({
        where: { id: outboxId },
        data: {
          status: "DEAD_LETTER",
          lastError: "conversation_outbox_attempts_exhausted",
        },
      });
      return null;
    }
    const outbox = await tx.outboxEvent.update({
      where: { id: outboxId },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        availableAt: new Date(
          Date.now()
          + Math.max(
            conversationOutboxProcessingLeaseMs,
            options.processingLeaseMs ?? conversationOutboxProcessingLeaseMs,
          ),
        ),
        processedAt: null,
        lastError: null,
      },
    });
    const message = await tx.message.findUnique({
      where: { id: outbox.aggregateId },
      include: {
        channelBinding: {
          include: {
            representativeBinding: {
              select: {
                connectionId: true,
                externalUserId: true,
                telegramBotConnectionId: true,
                endpointAssignmentRevision: true,
                endpointLifecycleRevision: true,
                telegramBotConnection: {
                  select: {
                    id: true,
                    botId: true,
                    status: true,
                  },
                },
              },
            },
          },
        },
        conversation: {
          include: {
            representative: {
              select: {
                id: true,
                ownerId: true,
              },
            },
          },
        },
      },
    });
    if (!message?.channelBinding || !message.text) {
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: { status: "DEAD_LETTER", lastError: "operator_message_or_channel_missing" },
      });
      return null;
    }
    if (message.externalMessageId) {
      await tx.message.update({
        where: { id: message.id },
        data: {
          deliveryStatus: MessageDeliveryStatus.SENT,
          failureCode: null,
          failureReason: null,
        },
      });
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: {
          status: "PROCESSED",
          processedAt: new Date(),
          lastError: null,
        },
      });
      return null;
    }
    const channel = message.channelBinding.kind === RepresentativeChannelKind.MATRIX
      ? "matrix"
      : message.channelBinding.kind === RepresentativeChannelKind.TELEGRAM
        ? "telegram"
        : null;
    if (!channel) {
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: { status: "DEAD_LETTER", lastError: "unsupported_operator_channel" },
      });
      return null;
    }
    if (channel === "telegram") {
      const endpointAvailability =
        resolveTelegramDeliveryEndpointAvailability({
          conversationConnectionId: message.channelBinding.connectionId,
          representativeConnectionId:
            message.channelBinding.representativeBinding?.connectionId,
          conversationRepresentativeAssignmentRevision:
            message.channelBinding.representativeAssignmentRevision,
          representativeAssignmentRevision:
            message.channelBinding.representativeBinding
              ?.endpointAssignmentRevision,
          ...(outbox.connectionId?.trim()
            ? { expectedConnectionId: outbox.connectionId }
            : {}),
          representativeTelegramBotConnectionId:
            message.channelBinding.representativeBinding
              ?.telegramBotConnectionId,
          representativeTelegramBot:
            message.channelBinding.representativeBinding
              ?.telegramBotConnection,
        });
      if (!endpointAvailability.available) {
        await tx.message.update({
          where: { id: message.id },
          data: {
            deliveryStatus: MessageDeliveryStatus.CANCELED,
            failureCode: endpointAvailability.code,
            failureReason:
              "Telegram delivery was canceled because this conversation belongs to a previously assigned Bot.",
          },
        });
        await tx.outboxEvent.update({
          where: { id: outbox.id },
          data: {
            status: "DEAD_LETTER",
            lastError: endpointAvailability.code,
          },
        });
        return null;
      }
    }
    if (channel === "matrix") {
      const endpointAvailability =
        resolveMatrixDeliveryEndpointAvailability({
          conversationRepresentativeMatrixUserId:
            readMatrixRepresentativeUserId(message.channelBinding.metadata),
          representativeMatrixUserId:
            message.channelBinding.representativeBinding?.externalUserId,
          conversationRepresentativeAssignmentRevision:
            message.channelBinding.representativeAssignmentRevision,
          representativeAssignmentRevision:
            message.channelBinding.representativeBinding
              ?.endpointAssignmentRevision,
        });
      if (!endpointAvailability.available) {
        await tx.message.update({
          where: { id: message.id },
          data: {
            deliveryStatus: MessageDeliveryStatus.CANCELED,
            failureCode: endpointAvailability.code,
            failureReason:
              "Matrix delivery was canceled because this room belongs to a previously assigned representative identity.",
          },
        });
        await tx.outboxEvent.update({
          where: { id: outbox.id },
          data: {
            status: "DEAD_LETTER",
            lastError: endpointAvailability.code,
          },
        });
        return null;
      }
      const currentLifecycleRevision =
        message.channelBinding.representativeBinding
          ?.endpointLifecycleRevision;
      if (
        !Number.isSafeInteger(message.channelLifecycleRevision)
        || (message.channelLifecycleRevision ?? 0) <= 0
        || !Number.isSafeInteger(currentLifecycleRevision)
        || (currentLifecycleRevision ?? 0) <= 0
        || message.channelLifecycleRevision !== currentLifecycleRevision
      ) {
        const failureCode = "matrix_channel_lifecycle_reactivated";
        await tx.message.update({
          where: { id: message.id },
          data: {
            deliveryStatus: MessageDeliveryStatus.CANCELED,
            failureCode,
            failureReason:
              "Matrix delivery was canceled because it belongs to an earlier channel activation.",
          },
        });
        await tx.outboxEvent.update({
          where: { id: outbox.id },
          data: {
            status: "DEAD_LETTER",
            lastError: failureCode,
          },
        });
        return null;
      }
    }
    if (channel === "telegram" && options.telegramWorkerEnabled === false) {
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: {
          status: "PENDING",
          attemptCount: { decrement: 1 },
          availableAt: new Date(Date.now() + telegramWorkerOwnershipRetryMs),
          lastError: "telegram_worker_not_delivery_owner",
        },
      });
      return null;
    }
    // Matrix MVP rooms are exact two-member rooms. Human replies retain
    // Message.senderType=OPERATOR in Delegate, but use the already joined
    // representative MXID for transport; a third Operator MXID would isolate
    // the room.
    const matrixTransportUser = channel === "matrix"
      ? await tx.matrixVirtualUserBinding.findFirst({
          where: {
            representativeId: message.conversation.representative.id,
            kind: "REPRESENTATIVE",
            enabled: true,
          },
          select: { matrixUserId: true },
        })
      : null;
    const telegramConnectionId =
      channel === "telegram"
        ? message.channelBinding.representativeBinding?.connectionId || null
        : null;
    return {
      outboxId: outbox.id,
      messageId: message.id,
      conversationId: message.conversationId,
      text: message.text,
      operatorName: message.senderDisplayName || "Operator",
      channel,
      externalConversationId: message.channelBinding.externalConversationId,
      ...(telegramConnectionId
        ? { telegramConnectionId }
        : {}),
      ...(matrixTransportUser
        ? {
            matrixSenderUserId: matrixTransportUser.matrixUserId,
            matrixEndpointLifecycleRevision:
              message.channelLifecycleRevision!,
          }
        : {}),
    };
  });
}

export async function completeOperatorMessageDelivery(input: {
  outboxId: string;
  messageId: string;
  externalMessageId?: string;
}) {
  await prisma.$transaction([
    prisma.message.update({
      where: { id: input.messageId },
      data: {
        deliveryStatus: MessageDeliveryStatus.SENT,
        ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
        failureCode: null,
        failureReason: null,
      },
    }),
    prisma.outboxEvent.update({
      where: { id: input.outboxId },
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
    }),
  ]);
}

export async function deferOperatorMessageDelivery(input: {
  outboxId: string;
  messageId: string;
  reason: string;
  retryAfterMs?: number;
}) {
  const retryAfterMs = Math.max(
    telegramWorkerOwnershipRetryMs,
    input.retryAfterMs ?? telegramWorkerOwnershipRetryMs,
  );
  return prisma.$transaction(async (tx) => {
    const deferred = await tx.outboxEvent.updateMany({
      where: {
        id: input.outboxId,
        status: "PROCESSING",
        attemptCount: { gt: 0 },
      },
      data: {
        status: "PENDING",
        attemptCount: { decrement: 1 },
        availableAt: new Date(Date.now() + retryAfterMs),
        processedAt: null,
        lastError: input.reason,
      },
    });
    if (deferred.count === 0) return false;
    await tx.message.update({
      where: { id: input.messageId },
      data: {
        deliveryStatus: MessageDeliveryStatus.QUEUED,
        failureCode: null,
        failureReason: null,
      },
    });
    return true;
  });
}

export async function retryOperatorMessageDelivery(input: {
  outboxId: string;
  messageId: string;
  errorMessage: string;
}) {
  const outbox = await prisma.outboxEvent.findUnique({
    where: { id: input.outboxId },
    select: { attemptCount: true },
  });
  const deadLetter = (outbox?.attemptCount || 0) >= 5;
  await prisma.$transaction([
    prisma.message.update({
      where: { id: input.messageId },
      data: {
        deliveryStatus: MessageDeliveryStatus.FAILED,
        failureCode: "operator_channel_delivery_failed",
        failureReason: input.errorMessage,
      },
    }),
    prisma.outboxEvent.update({
      where: { id: input.outboxId },
      data: {
        status: deadLetter ? "DEAD_LETTER" : "FAILED",
        lastError: input.errorMessage,
        availableAt: new Date(Date.now() + Math.min(60_000, 2 ** (outbox?.attemptCount || 1) * 1_000)),
      },
    }),
  ]);
}

export async function failGenerationRun(input: {
  conversationId: string;
  runId: string;
  outboxId: string;
  leaseAttempt: number;
  errorCode: string;
  errorMessage: string;
}) {
  const now = new Date();
  return runConversationWriteTransaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))
    `;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.runId}))`;
    await fenceGenerationWorkLease(tx, input);
    const terminalFailure = input.leaseAttempt >= GENERATION_WORK_MAX_ATTEMPTS;
    if (terminalFailure) {
      await releaseConversationEntitlementByGenerationRunId(
        {
          generationRunId: input.runId,
          reason: input.errorCode,
        },
        tx as unknown as ServiceEntitlementClient,
      );
    }
    const run = await tx.generationRun.update({
      where: { id: input.runId },
      data: {
        status: GenerationRunStatus.FAILED,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        completedAt: now,
      },
      include: {
        delegationTaskStep: {
          select: { kind: true },
        },
      },
    });
    if (run.conversationId !== input.conversationId) {
      throw new Error("Generation run does not belong to the conversation.");
    }
    if (terminalFailure) {
      const memoryUseRun = await tx.memoryUseRun.findFirst({
        where: {
          generationRunId: run.id,
          status: "STARTED",
        },
        select: { id: true },
      });
      if (memoryUseRun) {
        await failMemoryUseRunInTransaction(
          tx,
          memoryUseRun.id,
          "memory_generation_failed",
          now,
        );
      }
    }
    await tx.message.update({
      where: { id: run.inputMessageId },
      data: {
        deliveryStatus: MessageDeliveryStatus.FAILED,
        failureCode: input.errorCode,
        failureReason: input.errorMessage,
      },
    });
    await tx.conversation.updateMany({
      where: {
        id: run.conversationId,
        state: { notIn: ["HUMAN_ACTIVE", "NEEDS_HUMAN"] },
      },
      data: { state: "FAILED" },
    });
    const failedOutbox = await tx.outboxEvent.updateMany({
      where: {
        id: input.outboxId,
        aggregateType: "generation_run",
        aggregateId: run.id,
        eventType: "generation.requested",
        status: "PROCESSING",
        attemptCount: input.leaseAttempt,
      },
      data: {
        status: terminalFailure ? "DEAD_LETTER" : "FAILED",
        lastError: input.errorMessage,
        availableAt: new Date(now.getTime() + 2_000),
      },
    });
    if (failedOutbox.count !== 1) {
      throw new GenerationWorkLeaseLostError(
        input.outboxId,
        input.leaseAttempt,
      );
    }
    const walletReservation = readGenerationWalletReservation(
      run.runtimePolicySnapshot,
    );
    if (
      walletReservation
      && terminalFailure
      && !delegationTaskOwnsGenerationBilling(run)
    ) {
      await releaseConversationWalletUsage(
        {
          usageChargeId: walletReservation.usageChargeId,
          expectedGenerationRunId: run.id,
          failed: true,
          reason: input.errorCode,
          idempotencyKey: `generation:${run.id}:release`,
        },
        tx as unknown as UsageChargeClient,
      );
    }
    return run;
  });
}

export async function getPublicGenerationRunSnapshot(input: {
  representativeSlug: string;
  runId: string;
  audienceIdentityId: string;
  audienceId: string;
}) {
  const run = await prisma.generationRun.findFirst({
    where: {
      id: input.runId,
      conversation: {
        representative: { slug: input.representativeSlug },
        audienceIdentityId: input.audienceIdentityId,
        sourceChannel: "web",
        channelThreadId: buildWebConversationThreadId(input.audienceId),
      },
    },
    include: {
      outputMessage: {
        select: {
          id: true,
          text: true,
          content: true,
          deliveryStatus: true,
          failureCode: true,
          createdAt: true,
          citations: {
            select: {
              title: true,
              excerpt: true,
              memoryUseItem: { select: { id: true } },
            },
          },
          attachments: {
            select: { id: true, fileName: true, mimeType: true, sizeBytes: true, externalUrl: true },
          },
        },
      },
    },
  });
  if (!run) return null;

  const memoryDeliveryBlocked =
    run.outputMessage?.failureCode === GENERATION_MEMORY_DELIVERY_BLOCKED_ERROR;

  const sourceDisclosure = run.outputMessage && !memoryDeliveryBlocked
    ? resolvePublicWebAnswerSourceDisclosure({
        modelGenerated:
          readConversationGenerationRuntimeOutcome(run.contextSnapshot)?.mode
          === "model",
        hasAuthorizedCitation: run.outputMessage.citations.length > 0,
      })
    : null;

  return {
    id: run.id,
    status: memoryDeliveryBlocked ? "canceled" : run.status.toLowerCase(),
    ...(!memoryDeliveryBlocked && run.errorCode ? { errorCode: run.errorCode } : {}),
    ...(!memoryDeliveryBlocked && run.errorMessage ? { errorMessage: run.errorMessage } : {}),
    ...(run.outputMessage && !memoryDeliveryBlocked
      ? {
          message: {
            id: run.outputMessage.id,
            text: renderPublicConversationMessageText(run.outputMessage),
            status: run.outputMessage.deliveryStatus.toLowerCase(),
            createdAt: run.outputMessage.createdAt.toISOString(),
            ...(sourceDisclosure ? { sourceDisclosure } : {}),
            citations: run.outputMessage.citations.map((citation) => ({
              title: citation.title,
              ...(citation.excerpt ? { excerpt: citation.excerpt } : {}),
            })),
            ...(run.outputMessage.citations.some(
              (citation) => Boolean(citation.memoryUseItem),
            )
              ? {
                  displayAck: {
                    runId: run.id,
                    outputMessageId: run.outputMessage.id,
                  },
                }
              : {}),
            attachments: run.outputMessage.attachments.map((attachment) => ({
              id: attachment.id,
              fileName: attachment.fileName,
              ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
              ...(typeof attachment.sizeBytes === "number" ? { sizeBytes: attachment.sizeBytes } : {}),
              ...(attachment.externalUrl ? { url: attachment.externalUrl } : {}),
            })),
          },
        }
      : {}),
  };
}

export async function getPublicConversationHistory(input: {
  representativeSlug: string;
  audienceIdentityId: string;
  audienceId: string;
  limit?: number;
}) {
  const conversation = await prisma.conversation.findFirst({
    where: {
      representative: { slug: input.representativeSlug },
      audienceIdentityId: input.audienceIdentityId,
      sourceChannel: "web",
      channelThreadId: buildWebConversationThreadId(input.audienceId),
    },
    include: {
      messages: {
        where: {
          redactedAt: null,
          OR: [
            { senderType: { not: MessageSenderType.REPRESENTATIVE } },
            { failureCode: null },
            {
              failureCode: {
                not: GENERATION_MEMORY_DELIVERY_BLOCKED_ERROR,
              },
            },
          ],
        },
        include: {
          citations: {
            select: {
              title: true,
              excerpt: true,
              memoryUseItem: {
                select: {
                  useRun: { select: { generationRunId: true } },
                },
              },
            },
          },
          attachments: {
            select: { id: true, fileName: true, mimeType: true, sizeBytes: true, externalUrl: true },
          },
          outputForGenerationRuns: {
            where: { status: GenerationRunStatus.COMPLETED },
            select: {
              contextSnapshot: true,
            },
            orderBy: { completedAt: "desc" },
            take: 1,
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: Math.max(1, Math.min(200, input.limit || 100)),
      },
      assignments: {
        where: { status: ConversationAssignmentStatus.ACTIVE },
        orderBy: { assignedAt: "desc" },
        take: 1,
      },
      episodes: { orderBy: { sequence: "desc" }, take: 1 },
    },
    orderBy: { lastMessageAt: "desc" },
  });
  if (!conversation) {
    return { state: "new", humanActive: false, freeRepliesUsed: 0, messages: [] };
  }
  return {
    state: conversation.state.toLowerCase(),
    humanActive: Boolean(conversation.assignments[0]),
    freeRepliesUsed: conversation.freeRepliesUsed,
    messages: conversation.messages
      .filter((message) => !(
        message.senderType === MessageSenderType.REPRESENTATIVE
        && message.failureCode === GENERATION_MEMORY_DELIVERY_BLOCKED_ERROR
      ))
      .map((message) => {
      const displayRunId = message.citations.find(
        (citation) => Boolean(citation.memoryUseItem),
      )?.memoryUseItem?.useRun.generationRunId;
      const generation = message.outputForGenerationRuns[0];
      const sourceDisclosure = message.senderType === MessageSenderType.REPRESENTATIVE
        ? resolvePublicWebAnswerSourceDisclosure({
            modelGenerated:
              readConversationGenerationRuntimeOutcome(
                generation?.contextSnapshot,
              )?.mode === "model",
            hasAuthorizedCitation: message.citations.length > 0,
          })
        : null;
      return {
        id: message.id,
        role: message.senderType === MessageSenderType.AUDIENCE ? ("user" as const) : ("assistant" as const),
        senderType: normalizeSenderType(message.senderType),
        ...(message.senderDisplayName ? { senderDisplayName: message.senderDisplayName } : {}),
        text: renderPublicConversationMessageText(message),
        status: message.deliveryStatus.toLowerCase(),
        createdAt: message.createdAt.toISOString(),
        ...(sourceDisclosure ? { sourceDisclosure } : {}),
        citations: message.citations.map((citation) => ({
          title: citation.title,
          ...(citation.excerpt ? { excerpt: citation.excerpt } : {}),
        })),
        ...(displayRunId
          ? {
              displayAck: {
                runId: displayRunId,
                outputMessageId: message.id,
              },
            }
          : {}),
        attachments: message.attachments.map((attachment) => ({
          id: attachment.id,
          fileName: attachment.fileName,
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          ...(typeof attachment.sizeBytes === "number" ? { sizeBytes: attachment.sizeBytes } : {}),
          ...(attachment.externalUrl ? { url: attachment.externalUrl } : {}),
        })),
      };
      }),
  };
}

export function renderPublicConversationMessageText(message: {
  text?: string | null;
  content?: unknown;
  attachments?: Array<{ fileName: string }>;
}) {
  const text = message.text || "";
  const content = message.content && typeof message.content === "object" && !Array.isArray(message.content)
    ? message.content as Record<string, unknown>
    : null;
  const hasInternalPath = /\/(?:workspace|tmp)(?:\/|\b)/i.test(text);
  if (!hasInternalPath) return text;

  const attachmentLines = message.attachments?.length
    ? message.attachments.map((attachment) => `已生成文件：${attachment.fileName.split("/").pop() || "result.txt"}`).join("\n")
    : "没有生成可展示的结果文件。";
  const credits = typeof content?.actualCredits === "number"
    ? `\n\n消耗：${content.actualCredits} credits`
    : "";
  if (content?.kind === "compute_approval_result") {
    const outcome = content.outcome;
    if (outcome === "completed") return `审批已通过，委托任务执行完成。\n\n${attachmentLines}${credits}`;
    if (outcome === "rejected") return "委托任务未获批准，因此没有执行。";
    if (outcome === "expired") return "委托任务审批已超时，任务未执行。如仍需要，请重新提交请求。";
    if (outcome === "policy_denied") return "审批后安全策略复核未通过，任务没有执行。";
    return `审批已通过，但委托任务执行失败。\n\n${attachmentLines}${credits}`;
  }
  if (content?.kind === "compute_approval_pending") {
    return text.replace(/操作：[\s\S]*?(?=\n\n风险：)/, "操作：执行已提交的委托任务");
  }
  if (content?.intent === "compute") {
    return `委托任务执行结果。\n\n${attachmentLines}${credits}`;
  }
  return text;
}

/**
 * Durably records Matrix provider arrivals before the bridge performs any
 * remote room validation or disclosure delivery. This is persistence-only:
 * business ingestion remains in ingestMatrixApplicationServiceTransaction.
 */
export async function persistMatrixApplicationServiceProviderArrivals(input: {
  transactionId: string;
  events: MatrixApplicationServiceEvent[];
}): Promise<void> {
  await persistMatrixApplicationServiceEvents(input);
}

async function persistMatrixApplicationServiceEvents(input: {
  transactionId: string;
  events: MatrixApplicationServiceEvent[];
}): Promise<PersistedMatrixApplicationServiceEvent[]> {
  const persistedEvents: PersistedMatrixApplicationServiceEvent[] = [];
  const matrixConnectionId = resolveMatrixApplicationServiceConnectionId();
  const directInviteTargetByRoomId = new Map<string, string>();
  for (const event of input.events) {
    const roomId = event.room_id?.trim();
    const managedMatrixUserId = event.state_key?.trim();
    if (
      roomId
      && managedMatrixUserId
      && isExplicitMatrixDirectInvite(event)
      && !directInviteTargetByRoomId.has(roomId)
    ) {
      directInviteTargetByRoomId.set(roomId, managedMatrixUserId);
    }
  }
  const arrivalFenceByRoomId = new Map<
    string,
    Promise<MatrixProviderArrivalFence | null>
  >();

  // Matrix homeservers retry transactions, so the immutable provider event id
  // is both the durable arrival identity and the idempotency key.
  for (const event of input.events) {
    const eventId = event.event_id?.trim();
    const eventType = event.type?.trim();
    if (!eventId || !eventType) continue;
    const sanitizedEvent = sanitizeMatrixApplicationServiceEvent(event);
    const roomId = event.room_id?.trim();
    let arrivalFence: MatrixProviderArrivalFence | null = null;
    if (roomId) {
      let pendingFence = arrivalFenceByRoomId.get(roomId);
      if (!pendingFence) {
        pendingFence = resolveMatrixProviderArrivalFence({
          roomId,
          managedMatrixUserId:
            directInviteTargetByRoomId.get(roomId) ?? null,
        });
        arrivalFenceByRoomId.set(roomId, pendingFence);
      }
      arrivalFence = await pendingFence;
    }
    const arrivalPayload = buildMatrixProviderArrivalPayload(
      sanitizedEvent.event,
      arrivalFence,
    );

    const inbox = await prisma.channelEventInbox.upsert({
      where: {
        kind_connectionId_externalEventId: {
          kind: RepresentativeChannelKind.MATRIX,
          connectionId: matrixConnectionId,
          externalEventId: eventId,
        },
      },
      create: {
        kind: RepresentativeChannelKind.MATRIX,
        transport: ChannelTransport.MATRIX,
        sourceProvider: ChannelSourceProvider.MATRIX,
        connectionId: matrixConnectionId,
        originKey: `matrix:${matrixConnectionId}:${eventId}`,
        transactionId: input.transactionId,
        externalEventId: eventId,
        eventType,
        payload: arrivalPayload,
        privateCredentialHash: sanitizedEvent.privateCredentialHash,
        status: "PENDING",
        attemptCount: 0,
      },
      // The first payload is canonical. A replay with the same Matrix event id
      // must not replace the forensic record or repeat side effects.
      update: {},
      select: {
        id: true,
        status: true,
        attemptCount: true,
        eventType: true,
        payload: true,
        privateCredentialHash: true,
        lastError: true,
      },
    });

    const persistedPayload = isJsonRecord(inbox.payload)
      ? inbox.payload
      : arrivalPayload;
    // Only the envelope on the immutable first payload is trusted. A replay
    // cannot add a fence to a legacy row or replace the arrival lifecycle with
    // the endpoint's current lifecycle.
    const persistedArrivalFence = readMatrixProviderArrivalFence(
      persistedPayload[matrixProviderArrivalFencePayloadKey],
    );
    const sanitizedPersistedEvent = sanitizeMatrixApplicationServiceEvent(
      persistedPayload as MatrixApplicationServiceEvent,
    ).event;
    const canonicalPersistedPayload = buildMatrixProviderArrivalPayload(
      sanitizedPersistedEvent,
      persistedArrivalFence,
    );
    if (
      JSON.stringify(canonicalPersistedPayload)
      !== JSON.stringify(persistedPayload)
    ) {
      await prisma.channelEventInbox.update({
        where: { id: inbox.id },
        data: {
          payload: canonicalPersistedPayload,
        },
      });
    }

    persistedEvents.push({
      eventId,
      eventType: inbox.eventType,
      event: sanitizedPersistedEvent,
      inboxId: inbox.id,
      inboxStatus: inbox.status,
      attemptCount: inbox.attemptCount,
      lastError: inbox.lastError,
      privateCredentialHash: inbox.privateCredentialHash ?? null,
      arrivalFence: persistedArrivalFence,
    });
  }
  return persistedEvents;
}

/**
 * Loads the immutable provider payload and admits content only when its first
 * durable arrival happened in the exact lifecycle that is still active.
 * Encryption plus leave/ban membership state is deliberately exempt because
 * it can only tighten room safety. Invite/join/knock state can grant access,
 * so it must prove the same lifecycle as ordinary content.
 */
export async function admitCurrentMatrixApplicationServiceProviderEvents(
  events: MatrixApplicationServiceEvent[],
): Promise<MatrixProviderArrivalAdmissionResult> {
  const matrixConnectionId = resolveMatrixApplicationServiceConnectionId();
  const eventIds = [...new Set(events.flatMap((event) => {
    const eventId = event.event_id?.trim();
    return eventId ? [eventId] : [];
  }))];
  if (eventIds.length === 0) return { events: [], ignored: [] };

  const rows = await prisma.channelEventInbox.findMany({
    where: {
      kind: RepresentativeChannelKind.MATRIX,
      connectionId: matrixConnectionId,
      externalEventId: { in: eventIds },
    },
    select: {
      id: true,
      externalEventId: true,
      eventType: true,
      payload: true,
      status: true,
    },
  });
  const rowByEventId = new Map(
    rows.map((row) => [row.externalEventId, row]),
  );
  const bindingByRoomId = new Map<
    string,
    Promise<Awaited<ReturnType<typeof loadCurrentMatrixArrivalBinding>>>
  >();
  const admittedEvents: MatrixApplicationServiceEvent[] = [];
  const ignored: MatrixProviderArrivalAdmissionResult["ignored"] = [];

  for (const incomingEvent of events) {
    const eventId = incomingEvent.event_id?.trim();
    if (!eventId) continue;
    const row = rowByEventId.get(eventId);
    if (!row || !isJsonRecord(row.payload)) continue;
    const canonicalEvent = sanitizeMatrixApplicationServiceEvent(
      row.payload as MatrixApplicationServiceEvent,
    ).event;
    if (
      row.eventType === "m.room.encryption"
      || isMatrixSafetyTighteningMembershipEvent(canonicalEvent)
    ) {
      admittedEvents.push(canonicalEvent);
      continue;
    }

    const arrivalFence = readMatrixProviderArrivalFence(
      row.payload[matrixProviderArrivalFencePayloadKey],
    );
    const roomId = canonicalEvent.room_id?.trim();
    let currentBinding = null;
    if (roomId) {
      let pendingBinding = bindingByRoomId.get(roomId);
      if (!pendingBinding) {
        pendingBinding = loadCurrentMatrixArrivalBinding(roomId);
        bindingByRoomId.set(roomId, pendingBinding);
      }
      currentBinding = await pendingBinding;
    }
    let matchesCurrentLifecycle = Boolean(
      currentBinding
      && matrixProviderArrivalFenceMatches({
        arrivalFence,
        representativeBindingId:
          currentBinding.representativeBindingId,
        representativeAssignmentRevision:
          currentBinding.representativeAssignmentRevision,
        currentBinding: currentBinding.representativeBinding,
      }),
    );
    if (
      !matchesCurrentLifecycle
      && !currentBinding
      && arrivalFence
      && isExplicitMatrixDirectInvite(canonicalEvent)
    ) {
      const currentEndpointBinding =
        await loadCurrentMatrixArrivalEndpointBinding(
          arrivalFence.representativeBindingId,
        );
      matchesCurrentLifecycle = matrixProviderArrivalFenceMatches({
        arrivalFence,
        representativeBindingId: arrivalFence.representativeBindingId,
        representativeAssignmentRevision:
          arrivalFence.endpointAssignmentRevision,
        currentBinding: currentEndpointBinding,
      });
    }
    if (matchesCurrentLifecycle) {
      admittedEvents.push(canonicalEvent);
      continue;
    }

    if (row.status !== "PROCESSED") {
      await markMatrixInboxProcessed(row.id);
    }
    ignored.push({
      eventId,
      reason: arrivalFence
        ? "matrix_provider_arrival_lifecycle_stale"
        : "matrix_provider_arrival_fence_missing",
    });
  }

  return { events: admittedEvents, ignored };
}

export async function ingestMatrixApplicationServiceTransaction(input: {
  transactionId: string;
  events: MatrixApplicationServiceEvent[];
}) {
  const results: MatrixApplicationServiceIngestResult[] = [];
  const persistedEvents = await persistMatrixApplicationServiceEvents(input);

  // An encryption state event and a direct invite can be delivered in the
  // same transaction. Refuse to create the room even when the invite happens
  // to appear first in the array; ordering must not weaken the MVP boundary.
  const encryptedRoomIds = new Set(
    persistedEvents.flatMap(({ eventType, event }) =>
      eventType === "m.room.encryption" && event.room_id?.trim()
        ? [event.room_id.trim()]
        : [],
    ),
  );
  const persistedEventOrder = new Map(
    persistedEvents.map(({ eventId }, index) => [eventId, index]),
  );
  const securityEvents = persistedEvents.filter(
    ({ eventType }) =>
      eventType === "m.room.encryption" || eventType === "m.room.member",
  );
  const contentEvents = persistedEvents.filter(
    ({ eventType }) =>
      eventType !== "m.room.encryption" && eventType !== "m.room.member",
  );

  // Matrix state events define whether a room is still safe to use. A
  // homeserver may place an earlier message/redaction before a later
  // encryption or membership event in the same transaction, so apply all
  // security state first and only then process room content.
  for (const persisted of [...securityEvents, ...contentEvents]) {
    const {
      eventId,
      eventType,
      event,
      inboxId,
      inboxStatus,
      attemptCount,
      lastError,
      privateCredentialHash,
      arrivalFence,
    } = persisted;
    if (inboxStatus === "PROCESSED") {
      results.push({ eventId, status: "duplicate" });
      continue;
    }
    if (inboxStatus === "DEAD_LETTER") {
      if (isMatrixMemorySafetyControlEvent(eventType, event)) {
        await prisma.channelEventInbox.update({
          where: { id: inboxId },
          data: {
            status: "FAILED",
            attemptCount: 0,
            processedAt: null,
            availableAt: new Date(Date.now() + matrixEventRetryDelayMs),
            lastError: "matrix_memory_control_reopened",
          },
        });
        results.push({
          eventId,
          status: "failed",
          reason: "matrix_memory_control_reopened",
        });
        continue;
      }
      results.push({
        eventId,
        status: "ignored",
        reason: "matrix_event_dead_lettered",
      });
      continue;
    }
    if (attemptCount >= matrixEventMaximumAttempts) {
      if (isMatrixMemorySafetyControlEvent(eventType, event)) {
        await prisma.channelEventInbox.update({
          where: { id: inboxId },
          data: {
            status: "FAILED",
            attemptCount: 0,
            processedAt: null,
            availableAt: new Date(Date.now() + matrixEventRetryDelayMs),
            lastError: lastError || "matrix_memory_control_retrying",
          },
        });
        results.push({
          eventId,
          status: "failed",
          reason: "matrix_memory_control_retrying",
        });
        continue;
      }
      await prisma.channelEventInbox.update({
        where: { id: inboxId },
        data: {
          status: "DEAD_LETTER",
          processedAt: new Date(),
          lastError: lastError || "matrix_event_attempts_exhausted",
        },
      });
      results.push({
        eventId,
        status: "ignored",
        reason: "matrix_event_attempts_exhausted",
      });
      continue;
    }

    const claimedAt = new Date();
    const claim = await prisma.channelEventInbox.updateMany({
      where: {
        id: inboxId,
        OR: [
          {
            status: { in: ["PENDING", "FAILED"] },
            availableAt: { lte: claimedAt },
          },
          {
            status: "PROCESSING",
            availableAt: { lte: claimedAt },
          },
        ],
      },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        availableAt: new Date(claimedAt.getTime() + matrixEventProcessingLeaseMs),
        processedAt: null,
        lastError: null,
      },
    });
    if (claim.count === 0) {
      const current = await prisma.channelEventInbox.findUnique({
        where: { id: inboxId },
        select: { status: true, lastError: true },
      });
      if (current?.status === "PROCESSED") {
        results.push({ eventId, status: "duplicate" });
      } else if (current?.status === "DEAD_LETTER") {
        results.push({
          eventId,
          status: "ignored",
          reason: "matrix_event_dead_lettered",
        });
      } else {
        results.push({
          eventId,
          status: "failed",
          reason: current?.lastError
            || lastError
            || (current?.status === "PROCESSING"
              ? "matrix_event_already_processing"
              : "matrix_event_retry_not_ready"),
        });
      }
      continue;
    }

    try {
      const roomId = event.room_id?.trim();
      if (
        !roomId
        || ![
          "m.room.message",
          "m.room.redaction",
          "m.room.member",
          "m.room.encryption",
        ].includes(eventType)
      ) {
        await markMatrixInboxProcessed(inboxId);
        results.push({
          eventId,
          status: "ignored",
          reason: !roomId ? "matrix_room_id_missing" : "matrix_event_type_unsupported",
        });
        continue;
      }

      if (eventType === "m.room.encryption") {
        await isolateMatrixConversationRoom({
          roomId,
          reason: "matrix_room_encrypted",
          eventId,
          ...(event.sender?.trim() ? { observedMemberId: event.sender.trim() } : {}),
        });
        await markMatrixInboxProcessed(inboxId);
        results.push({ eventId, status: "ignored", reason: "matrix_room_encrypted" });
        continue;
      }

      if (eventType === "m.room.member") {
        const membership = typeof event.content?.membership === "string"
          ? event.content.membership
          : "";
        const managedMatrixUserId = event.state_key?.trim();
        const audienceMatrixUserId = event.sender?.trim();
        const managedTarget = managedMatrixUserId
          ? await prisma.matrixVirtualUserBinding.findUnique({
              where: { matrixUserId: managedMatrixUserId },
              select: {
                representativeId: true,
                matrixUserId: true,
                enabled: true,
              },
            })
          : null;
        const isDirectInvite = isExplicitMatrixDirectInvite(event);
        if (
          membership === "invite"
          && managedTarget?.enabled
          && managedTarget.representativeId
          && audienceMatrixUserId
          && audienceMatrixUserId !== managedTarget.matrixUserId
          && isDirectInvite
        ) {
          if (!arrivalFence) {
            await markMatrixInboxProcessed(inboxId);
            results.push({
              eventId,
              status: "ignored",
              reason: "matrix_provider_arrival_fence_missing",
            });
            continue;
          }
          if (encryptedRoomIds.has(roomId)) {
            await markMatrixInboxProcessed(inboxId);
            results.push({ eventId, status: "ignored", reason: "matrix_room_encrypted" });
            continue;
          }
          const provisioned = await provisionMatrixDirectConversation({
            representativeId: managedTarget.representativeId,
            roomId,
            audienceMatrixUserId,
            representativeMatrixUserId: managedTarget.matrixUserId,
            expectedEndpointLifecycleRevision:
              arrivalFence.endpointLifecycleRevision,
            directInvite: true,
          });
          await markMatrixInboxProcessed(inboxId);
          results.push(
            provisioned.status === "isolated_conflict"
              ? {
                  eventId,
                  status: "ignored",
                  reason: provisioned.reason,
                }
              : { eventId, status: "processed" },
          );
          continue;
        }

        // Do not provision on an ordinary invite. Matrix clients may emit room
        // invitations for groups without a reliable 1:1 signal.
        if (membership === "invite" && managedTarget) {
          await markMatrixInboxProcessed(inboxId);
          results.push({
            eventId,
            status: "ignored",
            reason: "matrix_membership_not_explicit_direct_invite",
          });
          continue;
        }

        const membershipUpdate = managedMatrixUserId
          ? await recordMatrixRoomMembership({
              roomId,
              memberId: managedMatrixUserId,
              membership,
              eventId,
            })
          : null;
        await markMatrixInboxProcessed(inboxId);
        results.push(membershipUpdate
          ? {
              eventId,
              status: "ignored",
              reason: membershipUpdate.isolated
                ? "matrix_room_membership_isolated"
                : "matrix_room_membership_updated",
            }
          : {
              eventId,
              status: "ignored",
              reason: "matrix_membership_not_managed_invite",
            });
        continue;
      }

      const virtualSender = event.sender
        ? await prisma.matrixVirtualUserBinding.findUnique({
            where: { matrixUserId: event.sender },
            select: { id: true },
          })
        : null;
      if (virtualSender) {
        await markMatrixInboxProcessed(inboxId);
        results.push({ eventId, status: "ignored", reason: "matrix_managed_sender_echo" });
        continue;
      }

      const binding = await prisma.conversationChannelBinding.findFirst({
        where: {
          kind: RepresentativeChannelKind.MATRIX,
          externalConversationId: roomId,
        },
        include: {
          representativeBinding: {
            select: {
              id: true,
              status: true,
              desiredState: true,
              healthStatus: true,
              externalUserId: true,
              endpointAssignmentRevision: true,
              endpointLifecycleRevision: true,
            },
          },
          conversation: {
            include: {
              representative: {
                select: {
                  id: true,
                  slug: true,
                  lifecycleState: true,
                  activeVersionId: true,
                  publicMode: true,
                  runtimePolicyOverlays: {
                    where: { enabled: true },
                    select: {
                      enabled: true,
                      priority: true,
                      startsAt: true,
                      expiresAt: true,
                      payload: true,
                    },
                  },
                },
              },
              contact: {
                select: {
                  id: true,
                  channelUserId: true,
                  externalUserId: true,
                },
              },
              participants: {
                select: {
                  kind: true,
                  participantId: true,
                  leftAt: true,
                  metadata: true,
                },
              },
            },
          },
        },
      });
      if (!binding) {
        throw new Error("matrix_room_not_provisioned");
      }

      await prisma.channelEventInbox.update({
        where: { id: inboxId },
        data: { conversationId: binding.conversationId },
      });

      if (!isMatrixDirectBindingSafe(binding.metadata)) {
        if (
          readMatrixRoomSecurityState(binding.metadata)
          === "PENDING_REMOTE_VALIDATION"
        ) {
          await deferMatrixInboxEvent(
            inboxId,
            "matrix_room_pending_remote_validation",
          );
          results.push({
            eventId,
            status: "failed",
            reason: "matrix_room_pending_remote_validation",
          });
          continue;
        }
        await markMatrixInboxProcessed(inboxId);
        results.push({ eventId, status: "ignored", reason: "matrix_room_not_private_unencrypted" });
        continue;
      }

      const sender = event.sender?.trim();
      if (!sender || !isMatrixAudienceSenderAuthorized({
        sender,
        contact: binding.conversation.contact,
        participants: binding.conversation.participants,
      })) {
        await markMatrixInboxProcessed(inboxId);
        results.push({ eventId, status: "ignored", reason: "matrix_sender_not_authorized" });
        continue;
      }

      const observedAvailability = resolveChannelAvailability({
        channel: "matrix",
        lifecycleState:
          binding.conversation.representative.lifecycleState,
        activeVersionId:
          binding.conversation.representative.activeVersionId,
        publicMode: binding.conversation.representative.publicMode,
        binding: binding.representativeBinding
          ? {
              legacyStatus: binding.representativeBinding.status,
              desiredState: binding.representativeBinding.desiredState,
              healthStatus: binding.representativeBinding.healthStatus,
            }
          : null,
        matrixEndpoint: {
          conversationRepresentativeMatrixUserId:
            readMatrixRepresentativeUserId(binding.metadata),
          representativeMatrixUserId:
            binding.representativeBinding?.externalUserId,
          conversationRepresentativeAssignmentRevision:
            binding.representativeAssignmentRevision,
          representativeAssignmentRevision:
            binding.representativeBinding
              ?.endpointAssignmentRevision,
        },
        overlays:
          binding.conversation.representative.runtimePolicyOverlays.map(
            (overlay) => ({
              ...overlay,
              payload: isJsonRecord(overlay.payload)
                ? overlay.payload
                : {},
            }),
          ),
      });
      if (!observedAvailability.available) {
        await markMatrixInboxProcessed(inboxId);
        results.push({
          eventId,
          status: "ignored",
          reason: observedAvailability.code,
        });
        continue;
      }
      if (!binding.representativeBinding) {
        throw new ChannelUnavailableError("channel_not_connected");
      }
      const representativeMatrixUserId =
        binding.representativeBinding.externalUserId;
      if (!representativeMatrixUserId) {
        throw new ChannelUnavailableError("channel_disconnected");
      }
      const fenced = await withActiveMatrixRepresentativeChannelFence(
        {
          representativeId: binding.conversation.representative.id,
          representativeMatrixUserId,
        },
        async (tx): Promise<MatrixApplicationServiceIngestResult> => {
          // The representative lifecycle and channel health are read again
          // while the same lifecycle fence used by pause/disconnect is held.
          // That makes disconnect linearizable with bind, edit, redaction and
          // normal message side effects instead of protecting only delivery.
          const currentBinding =
            await tx.representativeChannelBinding.findUnique({
              where: {
                representativeId_kind: {
                  representativeId:
                    binding.conversation.representative.id,
                  kind: RepresentativeChannelKind.MATRIX,
                },
              },
              select: {
                id: true,
                status: true,
                desiredState: true,
                healthStatus: true,
                externalUserId: true,
                endpointAssignmentRevision: true,
                endpointLifecycleRevision: true,
                representative: {
                  select: {
                    lifecycleState: true,
                    activeVersionId: true,
                    publicMode: true,
                    runtimePolicyOverlays: {
                      where: { enabled: true },
                      select: {
                        enabled: true,
                        priority: true,
                        startsAt: true,
                        expiresAt: true,
                        payload: true,
                      },
                    },
                  },
                },
              },
            });
          const availability = resolveChannelAvailability({
            channel: "matrix",
            lifecycleState:
              currentBinding?.representative.lifecycleState ?? "ARCHIVED",
            activeVersionId:
              currentBinding?.representative.activeVersionId ?? null,
            publicMode:
              currentBinding?.representative.publicMode ?? false,
            binding: currentBinding
              ? {
                  legacyStatus: currentBinding.status,
                  desiredState: currentBinding.desiredState,
                  healthStatus: currentBinding.healthStatus,
                }
              : null,
            matrixEndpoint: {
              conversationRepresentativeMatrixUserId:
                readMatrixRepresentativeUserId(binding.metadata),
              representativeMatrixUserId: currentBinding?.externalUserId,
              conversationRepresentativeAssignmentRevision:
                binding.representativeAssignmentRevision,
              representativeAssignmentRevision:
                currentBinding?.endpointAssignmentRevision,
            },
            overlays:
              currentBinding?.representative.runtimePolicyOverlays.map(
                (overlay) => ({
                  ...overlay,
                  payload: isJsonRecord(overlay.payload)
                    ? overlay.payload
                    : {},
                }),
              ) ?? [],
          });
          if (!availability.available) {
            throw new ChannelUnavailableError(availability.code);
          }
          if (!matrixProviderArrivalFenceMatches({
            arrivalFence,
            representativeBindingId: binding.representativeBindingId,
            representativeAssignmentRevision:
              binding.representativeAssignmentRevision,
            currentBinding,
          })) {
            await markMatrixInboxProcessed(inboxId, tx);
            return {
              eventId,
              status: "ignored",
              reason: arrivalFence
                ? "matrix_provider_arrival_lifecycle_stale"
                : "matrix_provider_arrival_fence_missing",
            };
          }

          if (eventType === "m.room.redaction") {
            const eventContent = event.content || {};
            const redactedEventId = event.redacts?.trim()
              || (typeof eventContent.redacts === "string"
                ? eventContent.redacts.trim()
                : "");
            if (!redactedEventId) {
              await markMatrixInboxProcessed(inboxId, tx);
              return {
                eventId,
                status: "ignored",
                reason: "matrix_redaction_target_missing",
              };
            }
            const target = await tx.message.findFirst({
              where: {
                channelBindingId: binding.id,
                externalMessageId: redactedEventId,
              },
              select: { id: true, senderId: true, senderType: true },
            });
            if (!target) {
              await deferMatrixInboxEvent(
                inboxId,
                "matrix_redaction_target_not_found",
                tx,
              );
              return {
                eventId,
                status: "failed",
                reason: "matrix_redaction_target_not_found",
              };
            }
            if (!isMatrixMessageOwnedBySender(target, sender)) {
              await markMatrixInboxProcessed(inboxId, tx);
              return {
                eventId,
                status: "ignored",
                reason: "matrix_redaction_author_mismatch",
              };
            }
            try {
              await redactConversationMessage(
                {
                  representativeSlug:
                    binding.conversation.representative.slug,
                  conversationId: binding.conversationId,
                  messageId: target.id,
                  reason: "matrix_redaction",
                  matrixGuard: {
                    channelBindingId: binding.id,
                    roomId,
                    audienceMatrixUserId: sender,
                    representativeMatrixUserId,
                  },
                },
                tx,
              );
            } catch (error) {
              if (error instanceof ConversationWorkInFlightControlError) {
                await tx.channelEventInbox.update({
                  where: { id: inboxId },
                  data: {
                    status: "FAILED",
                    attemptCount: { decrement: 1 },
                    processedAt: null,
                    availableAt: new Date(
                      Date.now() + matrixEventRetryDelayMs,
                    ),
                    lastError: "matrix_redaction_delivery_in_flight",
                  },
                });
                return {
                  eventId,
                  status: "failed",
                  reason: "matrix_redaction_delivery_in_flight",
                };
              }
              if (
                !(error instanceof DelegationMessageRedactionConflictError)
              ) {
                throw error;
              }
              await markMatrixInboxProcessed(inboxId, tx);
              return {
                eventId,
                status: "ignored",
                reason: "matrix_redaction_delegation_active",
              };
            }
          } else {
            const content = event.content || {};
            const msgtype =
              typeof content.msgtype === "string" ? content.msgtype : "";
            const body =
              typeof content.body === "string" ? content.body.trim() : "";
            const relatesTo = isJsonRecord(content["m.relates_to"])
              ? content["m.relates_to"]
              : null;
            const relationType =
              relatesTo && typeof relatesTo.rel_type === "string"
                ? relatesTo.rel_type
                : null;
            const targetEventId =
              relatesTo && typeof relatesTo.event_id === "string"
                ? relatesTo.event_id.trim()
                : null;
            const identityBindingTokenHash =
              msgtype === "m.text" ? privateCredentialHash : null;

            if (identityBindingTokenHash) {
              try {
                await consumeMatrixIdentityBindingChallenge(
                  {
                    guard: {
                      channelBindingId: binding.id,
                      roomId,
                      audienceMatrixUserId: sender,
                      representativeMatrixUserId,
                    },
                    tokenHash: identityBindingTokenHash,
                    providerSubject: sender,
                    connectionId:
                      binding.connectionId
                      || resolveMatrixApplicationServiceConnectionId(),
                    matrixEventId: eventId,
                  },
                  tx,
                );
              } catch (error) {
                if (
                  error instanceof ChannelUnavailableError
                  || isRetryableMatrixIdentityBindingError(error)
                ) {
                  throw error;
                }
                await markMatrixInboxProcessed(inboxId, tx);
                return {
                  eventId,
                  status: "ignored",
                  reason: "matrix_identity_binding_rejected",
                };
              }
            } else if (!await hasActiveMatrixAudienceConnectionProof(
              {
                audienceIdentityId:
                  binding.conversation.audienceIdentityId,
                providerSubject: sender,
                issuer: matrixHomeserverFromUserId(sender),
                connectionId:
                  binding.connectionId
                  || resolveMatrixApplicationServiceConnectionId(),
              },
              tx,
            )) {
              await markMatrixInboxProcessed(inboxId, tx);
              return {
                eventId,
                status: "ignored",
                reason: "matrix_identity_connection_not_verified",
              };
            } else if (
              relationType === "m.replace"
              && targetEventId
            ) {
              const replacement = isJsonRecord(content["m.new_content"])
                ? content["m.new_content"]
                : null;
              const replacementText =
                replacement && typeof replacement.body === "string"
                  ? replacement.body.trim()
                  : body.replace(/^\*\s*/, "");
              const target = await tx.message.findFirst({
                where: {
                  channelBindingId: binding.id,
                  externalMessageId: targetEventId,
                },
                select: { id: true, senderId: true, senderType: true },
              });
              if (!target) {
                await deferMatrixInboxEvent(
                  inboxId,
                  "matrix_edit_target_not_found",
                  tx,
                );
                return {
                  eventId,
                  status: "failed",
                  reason: "matrix_edit_target_not_found",
                };
              }
              if (
                !replacementText
                || !isMatrixMessageOwnedBySender(target, sender)
              ) {
                await markMatrixInboxProcessed(inboxId, tx);
                return {
                  eventId,
                  status: "ignored",
                  reason: !isMatrixMessageOwnedBySender(target, sender)
                      ? "matrix_edit_author_mismatch"
                      : "matrix_edit_body_missing",
                };
              }
              try {
                await editConversationMessage(
                  {
                    representativeSlug:
                      binding.conversation.representative.slug,
                    conversationId: binding.conversationId,
                    messageId: target.id,
                    text: replacementText,
                    editedBy: sender,
                    matrixGuard: {
                      channelBindingId: binding.id,
                      roomId,
                      audienceMatrixUserId: sender,
                      representativeMatrixUserId,
                    },
                  },
                  tx,
                );
              } catch (error) {
                if (!(error instanceof DelegationMessageEditConflictError)) {
                  throw error;
                }
                await markMatrixInboxProcessed(inboxId, tx);
                return {
                  eventId,
                  status: "ignored",
                  reason: "matrix_edit_delegation_active",
                };
              }
            } else if (msgtype === "m.text" && body) {
              await acceptInboundConversationMessage(
                {
                  representativeSlug:
                    binding.conversation.representative.slug,
                  conversationId: binding.conversationId,
                  text: body,
                  senderId: sender,
                  senderDisplayName: sender,
                  clientMessageId: eventId,
                  channel: "matrix",
                  externalMessageId: eventId,
                  ...(typeof event.origin_server_ts === "number"
                    ? { occurredAt: new Date(event.origin_server_ts) }
                    : {}),
                },
                tx,
              );
            } else {
              await markMatrixInboxProcessed(inboxId, tx);
              return {
                eventId,
                status: "ignored",
                reason: "matrix_message_type_unsupported",
              };
            }
          }

          await markMatrixInboxProcessed(inboxId, tx);
          return { eventId, status: "processed" };
        },
      );
      if (!fenced.executed) {
        await markMatrixInboxProcessed(inboxId);
        results.push({
          eventId,
          status: "ignored",
          reason: "channel_disconnected",
        });
        continue;
      }
      results.push(fenced.value);
    } catch (error) {
      if (
        error instanceof ChannelUnavailableError
        && isTerminalMatrixAvailabilityCode(error.code)
      ) {
        await markMatrixInboxProcessed(inboxId);
        results.push({
          eventId,
          status: "ignored",
          reason: error.code,
        });
        continue;
      }
      const nextAttemptCount = attemptCount + 1;
      const deadLetter =
        !isMatrixMemorySafetyControlEvent(eventType, event)
        && nextAttemptCount >= matrixEventMaximumAttempts;
      await prisma.channelEventInbox.update({
        where: { id: inboxId },
        data: {
          status: deadLetter ? "DEAD_LETTER" : "FAILED",
          ...(deadLetter ? { processedAt: new Date() } : {}),
          lastError: error instanceof Error ? error.message : "matrix_event_processing_failed",
          availableAt: new Date(Date.now() + matrixEventRetryDelayMs),
        },
      });
      results.push({
        eventId,
        status: deadLetter ? "ignored" : "failed",
        reason: deadLetter
          ? "matrix_event_attempts_exhausted"
          : error instanceof Error
            ? error.message
            : "matrix_event_processing_failed",
      });
    }
  }

  // Processing order is security-first, but keep the response deterministic
  // in the homeserver's original event order for callers and diagnostics.
  return results.sort(
    (left, right) =>
      (persistedEventOrder.get(left.eventId) ?? Number.MAX_SAFE_INTEGER)
      - (persistedEventOrder.get(right.eventId) ?? Number.MAX_SAFE_INTEGER),
  );
}

export async function getMatrixVirtualUserBinding(matrixUserId: string) {
  const virtualUser = await prisma.matrixVirtualUserBinding.findFirst({
    where: { matrixUserId, enabled: true },
    select: {
      matrixUserId: true,
      kind: true,
      displayName: true,
      avatarUrl: true,
      representativeId: true,
      ownerId: true,
      representative: {
        select: {
          channelBindings: {
            where: {
              kind: RepresentativeChannelKind.MATRIX,
            },
            select: {
              externalUserId: true,
              endpointAssignmentRevision: true,
            },
            take: 1,
          },
        },
      },
    },
  });
  if (!virtualUser) return null;
  const currentAssignment =
    virtualUser.representative?.channelBindings[0];
  const {
    representative: _representative,
    ...binding
  } = virtualUser;
  return {
    ...binding,
    endpointAssignmentRevision:
      currentAssignment?.externalUserId === virtualUser.matrixUserId
        && currentAssignment.endpointAssignmentRevision > 0
        ? currentAssignment.endpointAssignmentRevision
        : null,
  };
}

export async function editConversationMessage(input: {
  representativeSlug: string;
  conversationId: string;
  messageId: string;
  text: string;
  editedBy: string;
  matrixGuard?: MatrixConversationMessageGuard;
  telegramGuard?: {
    connectionId: string;
    chatId: string;
    senderId: string;
    externalMessageId: string;
    updateId: number;
    editedAt: string;
  };
}, existingTransaction?: Prisma.TransactionClient) {
  const text = input.text.trim();
  if (!text) throw new Error("Edited message text is required.");
  const telegramGuard = input.telegramGuard
    ? normalizeTelegramMessageEditGuard(input.telegramGuard)
    : null;

  const edit = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))
    `;
    if (
      input.matrixGuard
      && !await lockAndVerifyMatrixDirectBinding(tx, {
        id: input.matrixGuard.channelBindingId,
        externalConversationId: input.matrixGuard.roomId,
        audienceMatrixUserId: input.matrixGuard.audienceMatrixUserId,
        representativeMatrixUserId:
          input.matrixGuard.representativeMatrixUserId,
      })
    ) {
      throw new ChannelUnavailableError(
        "matrix_private_room_not_verified",
      );
    }
    const message = await tx.message.findFirst({
      where: {
        id: input.messageId,
        conversationId: input.conversationId,
        conversation: { representative: { slug: input.representativeSlug } },
      },
      include: {
        revisions: { orderBy: { version: "desc" }, take: 1 },
        conversation: {
          select: { state: true },
        },
        channelBinding: {
          select: {
            kind: true,
            connectionId: true,
            externalConversationId: true,
          },
        },
        inputForGenerationRuns: {
          orderBy: { createdAt: "desc" },
          select: { id: true, delegationTaskId: true },
        },
      },
    });
    if (!message) throw new Error("Message not found.");
    if (telegramGuard) {
      if (
        message.senderType !== MessageSenderType.AUDIENCE
        || message.senderId !== telegramGuard.senderId
        || message.externalMessageId !== telegramGuard.externalMessageId
        || message.channelBinding?.kind !== RepresentativeChannelKind.TELEGRAM
        || message.channelBinding.connectionId !== telegramGuard.connectionId
        || message.channelBinding.externalConversationId !== telegramGuard.chatId
      ) {
        throw new Error("Telegram message edit scope is invalid.");
      }
      const watermarkClaim = await tx.message.updateMany({
        where: {
          id: message.id,
          conversationId: message.conversationId,
          OR: [
            {
              telegramLastEditAt: null,
              telegramLastEditUpdateId: null,
            },
            {
              telegramLastEditUpdateId: {
                lt: telegramGuard.updateId,
              },
            },
          ],
        },
        data: {
          telegramLastEditAt: telegramGuard.editedAt,
          telegramLastEditUpdateId: telegramGuard.updateId,
        },
      });
      if (watermarkClaim.count !== 1) {
        return {
          revision: message.revisions[0] ?? null,
          action: "update_only" as const,
          providerEditStatus: "superseded" as const,
        };
      }
    }
    const providerMemoryControl = Boolean(input.matrixGuard || telegramGuard);
    if (providerMemoryControl) {
      // Provider edits are privacy controls first and business-message edits
      // second. Fence derived memory before any delegation/generation
      // conflict can reject the body mutation. Matrix catches those conflicts
      // in its durable inbox transaction; Telegram does the same in the bot
      // transaction, so this safety mutation still commits.
      await invalidateMemoryExtractionForSourceMessage(tx, {
        messageId: message.id,
        reasonCode: "source_message_edited",
      });
    }
    if (message.redactedAt) throw new Error("Redacted messages cannot be edited.");
    if (message.text?.trim() === text) {
      return {
        revision: message.revisions[0] ?? null,
        action: "update_only" as const,
        ...(telegramGuard
          ? { providerEditStatus: "applied" as const }
          : {}),
      };
    }
    if (message.inputForGenerationRuns.some((run) => run.delegationTaskId)) {
      throw new DelegationMessageEditConflictError();
    }

    const runReference = message.inputForGenerationRuns[0];
    if (runReference) {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${runReference.id}))
      `;
    }
    const run = runReference
      ? await tx.generationRun.findUnique({ where: { id: runReference.id } })
      : null;
    if (runReference && !run) {
      throw new Error("Generation run not found.");
    }
    const activeOutboxes = run
      ? await tx.outboxEvent.findMany({
          where: {
            aggregateType: "generation_run",
            aggregateId: run.id,
            eventType: "generation.requested",
            status: { in: [...activeGenerationOutboxStatuses] },
          },
          select: { id: true },
        })
      : [];
    const humanControlsConversation =
      message.conversation.state === "HUMAN_ACTIVE"
      || message.conversation.state === "NEEDS_HUMAN";
    const action = humanControlsConversation || !run
      ? "update_only"
      : run.status === GenerationRunStatus.WAITING_HUMAN
        ? "update_only"
        : run.status === GenerationRunStatus.FAILED && activeOutboxes.length > 0
          ? "cancel_and_requeue"
          : resolveMessageEditAction(generationStateMap[run.status]);
    const revision = await tx.messageRevision.create({
      data: {
        messageId: message.id,
        version: (message.revisions[0]?.version ?? 0) + 1,
        text,
        editedBy: input.editedBy,
      },
    });

    await tx.message.update({
      where: { id: message.id },
      data: { text, editedAt: new Date(), deliveryStatus: MessageDeliveryStatus.EDITED },
    });
    if (!providerMemoryControl) {
      await invalidateMemoryExtractionForSourceMessage(tx, {
        messageId: message.id,
        reasonCode: "source_message_edited",
      });
    }

    if (run && (action === "replace_queued_run" || action === "cancel_and_requeue")) {
      const walletReservation = readGenerationWalletReservation(
        run.runtimePolicySnapshot,
      );
      const replacedAt = new Date();
      await tx.outboxEvent.updateMany({
        where: {
          aggregateType: "generation_run",
          aggregateId: run.id,
          eventType: "generation.requested",
          status: { in: [...activeGenerationOutboxStatuses] },
        },
        data: {
          status: "PROCESSED",
          processedAt: replacedAt,
          lastError: null,
        },
      });
      const replacement = await tx.generationRun.create({
        data: {
          conversationId: message.conversationId,
          episodeId: message.episodeId,
          inputMessageId: message.id,
          representativeVersionId: run.representativeVersionId,
          ...(run.delegationTaskId
            ? { delegationTaskId: run.delegationTaskId }
            : {}),
          ...(run.delegationTaskStepId
            ? { delegationTaskStepId: run.delegationTaskStepId }
            : {}),
          status: GenerationRunStatus.QUEUED,
          idempotencyKey: `reply:${message.conversationId}:${message.id}:revision:${revision.version}`,
          ...(run.runtimePolicySnapshot !== null
            ? { runtimePolicySnapshot: run.runtimePolicySnapshot }
            : {}),
        },
      });
      await transferConversationEntitlementByGenerationRunId(
        {
          fromGenerationRunId: run.id,
          toGenerationRunId: replacement.id,
        },
        tx as unknown as ServiceEntitlementClient,
      );
      if (walletReservation) {
        await transferAgentUsageEntitlementReservation(
          {
            usageChargeId: walletReservation.usageChargeId,
            fromGenerationRunId: run.id,
            toGenerationRunId: replacement.id,
            conversationId: message.conversationId,
          },
          tx as unknown as UsageChargeClient,
        );
      }
      const transferredSnapshot = markGenerationWalletTransferred(
        run.runtimePolicySnapshot,
        replacement.id,
      );
      const canceled = await tx.generationRun.updateMany({
        where: {
          id: run.id,
          status: { in: [run.status] },
        },
        data: {
          status: GenerationRunStatus.CANCELED,
          canceledAt: replacedAt,
          ...(transferredSnapshot
            ? { runtimePolicySnapshot: transferredSnapshot }
            : {}),
        },
      });
      if (canceled.count !== 1) {
        throw new Error(
          "Generation changed while its input message was being edited.",
        );
      }
      await tx.approvalRequest.updateMany({
        where: {
          generationRunId: run.id,
          status: "PENDING",
        },
        data: {
          status: "REJECTED",
          resolvedAt: replacedAt,
          resolvedBy: input.editedBy,
          decisionNote: "The input message was edited and the generation was replaced.",
        },
      });
      await tx.outboxEvent.create({
        data: {
          conversationId: message.conversationId,
          aggregateType: "generation_run",
          aggregateId: replacement.id,
          eventType: "generation.requested",
          payload: { runId: replacement.id, conversationId: message.conversationId, messageId: message.id },
          idempotencyKey: `generation.requested:${replacement.id}`,
        },
      });
      await tx.message.update({
        where: { id: message.id },
        data: {
          deliveryStatus: MessageDeliveryStatus.QUEUED,
          failureCode: null,
          failureReason: null,
        },
      });
      await tx.conversation.update({
        where: { id: message.conversationId },
        data: {
          state: "AI_QUEUED",
          lastMessageAt: replacedAt,
        },
      });
      if (message.episodeId) {
        await tx.conversationEpisode.updateMany({
          where: { id: message.episodeId },
          data: { status: ConversationEpisodeStatus.ACTIVE },
        });
      }
    }

    return {
      revision,
      action,
      ...(telegramGuard
        ? { providerEditStatus: "applied" as const }
        : {}),
    };
  };
  return existingTransaction
    ? edit(existingTransaction)
    : runConversationWriteTransaction(edit);
}

function normalizeTelegramMessageEditGuard(input: {
  connectionId: string;
  chatId: string;
  senderId: string;
  externalMessageId: string;
  updateId: number;
  editedAt: string;
}) {
  const connectionId = input.connectionId.trim();
  const chatId = input.chatId.trim();
  const senderId = input.senderId.trim();
  const externalMessageId = input.externalMessageId.trim();
  const editedAt = new Date(input.editedAt);
  if (
    !connectionId
    || !chatId
    || !senderId
    || !externalMessageId
    || !Number.isSafeInteger(input.updateId)
    || input.updateId < 0
    || !Number.isFinite(editedAt.getTime())
  ) {
    throw new Error("Telegram message edit guard is invalid.");
  }
  return {
    connectionId,
    chatId,
    senderId,
    externalMessageId,
    updateId: BigInt(input.updateId),
    editedAt,
  };
}

export async function redactConversationMessage(input: {
  representativeSlug: string;
  conversationId: string;
  messageId: string;
  reason?: string;
  matrixGuard?: MatrixConversationMessageGuard;
}, existingTransaction?: Prisma.TransactionClient) {
  const redactedAt = new Date();
  const redact = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))
    `;
    if (
      input.matrixGuard
      && !await lockAndVerifyMatrixDirectBinding(tx, {
        id: input.matrixGuard.channelBindingId,
        externalConversationId: input.matrixGuard.roomId,
        audienceMatrixUserId: input.matrixGuard.audienceMatrixUserId,
        representativeMatrixUserId:
          input.matrixGuard.representativeMatrixUserId,
      })
    ) {
      throw new ChannelUnavailableError(
        "matrix_private_room_not_verified",
      );
    }
    const message = await tx.message.findFirst({
      where: {
        id: input.messageId,
        conversationId: input.conversationId,
        conversation: { representative: { slug: input.representativeSlug } },
      },
      select: {
        id: true,
        conversationId: true,
        episodeId: true,
        inputForGenerationRuns: {
          orderBy: { createdAt: "asc" },
          select: { id: true },
        },
      },
    });
    if (!message) throw new Error("Message not found.");

    const providerMemoryControl = Boolean(input.matrixGuard);
    if (providerMemoryControl) {
      // A provider redaction must stop Recall even when an active delegation
      // or an in-flight delivery prevents the rest of the conversation
      // mutation. The Matrix inbox catches those conflicts inside this same
      // transaction, allowing the memory fence to commit independently of
      // the business control outcome.
      await invalidateMemoryExtractionForSourceMessage(tx, {
        messageId: message.id,
        reasonCode: "source_message_redacted",
        occurredAt: redactedAt,
      });
    }

    let canceledRunCount = 0;
    const releasedWalletReservations = new Set<string>();
    const runIds = message.inputForGenerationRuns
      .map((run) => run.id)
      .sort();
    for (const runId of runIds) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${runId}))`;
      const run = await tx.generationRun.findUnique({
        where: { id: runId },
        select: {
          id: true,
          status: true,
          delegationTaskId: true,
          delegationTask: {
            select: { status: true },
          },
          outputMessageId: true,
          outputMessage: {
            select: {
              id: true,
              deliveryStatus: true,
            },
          },
          runtimePolicySnapshot: true,
        },
      });
      if (!run) continue;
      if (
        run.delegationTaskId
        && (
          !run.delegationTask
          || !["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(
            run.delegationTask.status,
          )
        )
      ) {
        throw new DelegationMessageRedactionConflictError();
      }
      const activeOutbox = await tx.outboxEvent.findFirst({
        where: {
          aggregateType: "generation_run",
          aggregateId: run.id,
          eventType: "generation.requested",
          status: { in: [...activeGenerationOutboxStatuses] },
        },
        select: {
          id: true,
          status: true,
          availableAt: true,
          attemptCount: true,
        },
      });
      if (run.status === GenerationRunStatus.COMPLETED) {
        const outputDeliveryInterruptible = Boolean(
          run.outputMessage
          && (
            run.outputMessage.deliveryStatus
              === MessageDeliveryStatus.PROCESSING
            || run.outputMessage.deliveryStatus
              === MessageDeliveryStatus.QUEUED
            || run.outputMessage.deliveryStatus
              === MessageDeliveryStatus.FAILED
          ),
        );
        if (
          !run.outputMessage
          || !outputDeliveryInterruptible
        ) {
          continue;
        }
        if (
          run.outputMessage.deliveryStatus === MessageDeliveryStatus.PROCESSING
          && activeOutbox?.status === "PROCESSING"
          && activeOutbox.availableAt > redactedAt
        ) {
          throw new ConversationWorkInFlightControlError();
        }
        await tx.outboxEvent.updateMany({
          where: {
            aggregateType: "generation_run",
            aggregateId: run.id,
            eventType: "generation.requested",
            status: { in: [...activeGenerationOutboxStatuses] },
          },
          data: {
            status: "PROCESSED",
            processedAt: redactedAt,
            lastError: "input_message_redacted_before_delivery",
          },
        });
        await tx.message.updateMany({
          where: {
            id: run.outputMessage.id,
            deliveryStatus: {
              in: [
                MessageDeliveryStatus.PROCESSING,
                MessageDeliveryStatus.QUEUED,
                MessageDeliveryStatus.FAILED,
              ],
            },
          },
          data: {
            deliveryStatus: MessageDeliveryStatus.CANCELED,
            failureCode: "input_message_redacted_before_delivery",
            failureReason:
              "AI delivery was canceled because its input message was redacted.",
          },
        });
        continue;
      }
      const interruptible = cancellableGenerationStatuses.includes(run.status)
        || (
          run.status === GenerationRunStatus.FAILED
          && Boolean(activeOutbox)
        );
      if (!interruptible) continue;

      const walletReservation = readGenerationWalletReservation(
        run.runtimePolicySnapshot,
      );
      const releasedSnapshot = walletReservation
        ? markGenerationWalletReleased(
            run.runtimePolicySnapshot,
            redactedAt,
          )
        : null;
      const canceled = await tx.generationRun.updateMany({
        where: {
          id: run.id,
          status: {
            in: run.status === GenerationRunStatus.FAILED
              ? [GenerationRunStatus.FAILED]
              : cancellableGenerationStatuses,
          },
        },
        data: {
          status: GenerationRunStatus.CANCELED,
          errorCode: "input_message_redacted",
          errorMessage: "Generation canceled because its input message was redacted.",
          canceledAt: redactedAt,
          ...(releasedSnapshot
            ? { runtimePolicySnapshot: releasedSnapshot }
            : {}),
        },
      });
      if (canceled.count !== 1) continue;
      await releaseConversationEntitlementByGenerationRunId(
        {
          generationRunId: run.id,
          reason: "input_message_redacted",
        },
        tx as unknown as ServiceEntitlementClient,
      );
      if (
        walletReservation
        && !releasedWalletReservations.has(walletReservation.usageChargeId)
      ) {
        await releaseConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
            expectedGenerationRunId: run.id,
            reason: "input_message_redacted",
            idempotencyKey:
              `message:${message.id}:redaction:${walletReservation.usageChargeId}:release`,
          },
          tx as unknown as UsageChargeClient,
        );
        releasedWalletReservations.add(walletReservation.usageChargeId);
      }
      canceledRunCount += 1;

      await tx.outboxEvent.updateMany({
        where: {
          aggregateType: "generation_run",
          aggregateId: run.id,
          status: { in: ["PENDING", "PROCESSING", "FAILED"] },
        },
        data: {
          status: "PROCESSED",
          processedAt: redactedAt,
          lastError: null,
        },
      });
      await tx.approvalRequest.updateMany({
        where: {
          generationRunId: run.id,
          status: "PENDING",
        },
        data: {
          status: "REJECTED",
          resolvedAt: redactedAt,
          resolvedBy: "system",
          decisionNote: "Input message was redacted.",
        },
      });
    }

    const redacted = await tx.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: MessageDeliveryStatus.REDACTED,
        redactedAt,
        redactionReason: input.reason?.trim() || null,
        retentionExpiresAt: buildRedactionPurgeAt(redactedAt),
      },
    });
    if (!providerMemoryControl) {
      await invalidateMemoryExtractionForSourceMessage(tx, {
        messageId: message.id,
        reasonCode: "source_message_redacted",
        occurredAt: redactedAt,
      });
    }
    if (canceledRunCount > 0) {
      await tx.conversation.updateMany({
        where: {
          id: message.conversationId,
          state: { in: ["AI_QUEUED", "PROCESSING", "WAITING_APPROVAL"] },
        },
        data: { state: "WAITING_USER" },
      });
      if (message.episodeId) {
        await tx.conversationEpisode.updateMany({
          where: {
            id: message.episodeId,
            status: {
              in: [
                ConversationEpisodeStatus.ACTIVE,
                ConversationEpisodeStatus.WAITING_APPROVAL,
              ],
            },
          },
          data: { status: ConversationEpisodeStatus.WAITING_USER },
        });
      }
    }
    return redacted;
  };
  return existingTransaction
    ? redact(existingTransaction)
    : runConversationWriteTransaction(redact);
}

export async function markConversationRead(input: {
  representativeSlug: string;
  conversationId: string;
  operatorId: string;
}) {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: input.conversationId,
      representative: { slug: input.representativeSlug },
    },
    select: { id: true },
  });
  if (!conversation) throw new Error("Conversation not found.");

  const now = new Date();
  await prisma.$transaction([
    prisma.conversationReadState.upsert({
      where: {
        conversationId_operatorId: {
          conversationId: conversation.id,
          operatorId: input.operatorId,
        },
      },
      create: {
        conversationId: conversation.id,
        operatorId: input.operatorId,
        lastReadAt: now,
      },
      update: { lastReadAt: now },
    }),
    prisma.conversation.update({
      where: { id: conversation.id },
      data: { unreadCount: 0 },
    }),
  ]);
  return { readAt: now.toISOString() };
}

export async function addConversationInternalNote(input: {
  representativeSlug: string;
  conversationId: string;
  authorId: string;
  authorName: string;
  text: string;
}) {
  const text = input.text.trim();
  if (!text) throw new Error("Internal note text is required.");
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, representative: { slug: input.representativeSlug } },
    include: { episodes: { orderBy: { sequence: "desc" }, take: 1 } },
  });
  if (!conversation) throw new Error("Conversation not found.");
  return prisma.conversationInternalNote.create({
    data: {
      conversationId: conversation.id,
      ...(conversation.episodes[0] ? { episodeId: conversation.episodes[0].id } : {}),
      authorId: input.authorId,
      authorName: input.authorName,
      text,
    },
  });
}

export async function sendOperatorConversationMessage(input: {
  representativeSlug: string;
  conversationId: string;
  operatorId: string;
  operatorName: string;
  text: string;
  clientMessageId?: string;
}) {
  const text = input.text.trim();
  if (!text) throw new Error("Reply text is required.");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))`;
    const conversation = await tx.conversation.findFirst({
      where: { id: input.conversationId, representative: { slug: input.representativeSlug } },
      include: {
        episodes: { orderBy: { sequence: "desc" }, take: 1 },
        assignments: {
          where: { status: ConversationAssignmentStatus.ACTIVE },
          orderBy: { assignedAt: "desc" },
          take: 1,
        },
        channelBindings: {
          include: {
            representativeBinding: {
              select: {
                endpointLifecycleRevision: true,
              },
            },
          },
        },
      },
    });
    if (!conversation) throw new Error("Conversation not found.");
    const assignment = conversation.assignments[0];
    if (!assignment || assignment.operatorId !== input.operatorId) {
      throw new Error("Take over this conversation before replying.");
    }
    const episode = conversation.episodes[0];
    if (!episode) throw new Error("Conversation has no active episode.");

    const now = new Date();
    const channelBinding = conversation.channelBindings.find(
      (binding) => binding.kind === mapChannelKind(normalizeChannel(conversation.sourceChannel)),
    ) || conversation.channelBindings[0];
    const message = await tx.message.create({
      data: {
        conversationId: conversation.id,
        episodeId: episode.id,
        ...(channelBinding ? { channelBindingId: channelBinding.id } : {}),
        senderType: MessageSenderType.OPERATOR,
        senderId: input.operatorId,
        senderDisplayName: input.operatorName,
        contentType: MessageContentType.TEXT,
        text,
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
        ...(
          channelBinding?.kind !== RepresentativeChannelKind.WEB
          && channelBinding?.representativeBinding
          && channelBinding.representativeBinding.endpointLifecycleRevision > 0
            ? {
                channelLifecycleRevision:
                  channelBinding.representativeBinding.endpointLifecycleRevision,
              }
            : {}
        ),
        deliveryStatus:
          channelBinding?.kind === RepresentativeChannelKind.WEB
            ? MessageDeliveryStatus.SENT
            : MessageDeliveryStatus.QUEUED,
        retentionExpiresAt: buildMessageRetentionExpiry(now),
        createdAt: now,
      },
    });
    if (channelBinding && channelBinding.kind !== RepresentativeChannelKind.WEB) {
      await tx.outboxEvent.create({
        data: {
          conversationId: conversation.id,
          aggregateType: "operator_message",
          aggregateId: message.id,
          eventType: "operator.message.requested",
          ...(channelBinding.transport
            ? { transport: channelBinding.transport }
            : {}),
          ...(channelBinding.sourceProvider
            ? { sourceProvider: channelBinding.sourceProvider }
            : {}),
          ...(channelBinding.connectionId
            ? { connectionId: channelBinding.connectionId }
            : {}),
          payload: {
            messageId: message.id,
            conversationId: conversation.id,
            channel: channelBinding.kind.toLowerCase(),
          },
          idempotencyKey: `operator.message.requested:${message.id}`,
        },
      });
    }
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { state: "HUMAN_ACTIVE", lastMessageAt: now },
    });
    return message;
  });
}

export async function setConversationResolution(input: {
  representativeSlug: string;
  conversationId: string;
  operatorId: string;
  resolved: boolean;
  reason?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { id: input.conversationId, representative: { slug: input.representativeSlug } },
      include: { episodes: { orderBy: { sequence: "desc" }, take: 1 } },
    });
    if (!conversation) throw new Error("Conversation not found.");
    const episode = conversation.episodes[0];
    if (!episode) throw new Error("Conversation has no active episode.");
    const targetState: ConversationEpisodeState = input.resolved ? "resolved" : "active";
    assertConversationEpisodeTransition(episodeStateMap[episode.status], targetState);
    const now = new Date();

    await tx.conversationEpisode.update({
      where: { id: episode.id },
      data: input.resolved
        ? {
            status: ConversationEpisodeStatus.RESOLVED,
            endedAt: now,
            resolutionReason: input.reason?.trim() || "operator_resolved",
          }
        : {
            status: ConversationEpisodeStatus.ACTIVE,
            endedAt: null,
            resolutionReason: null,
          },
    });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { state: input.resolved ? "RESOLVED" : "ACTIVE" },
    });
    await tx.conversationStateTransition.create({
      data: {
        conversationId: conversation.id,
        fromState: conversation.state,
        toState: input.resolved ? "RESOLVED" : "ACTIVE",
        reason: input.reason?.trim() || (input.resolved ? "operator_resolved" : "operator_reopened"),
        actorType: "operator",
        actorId: input.operatorId,
      },
    });
    return { resolved: input.resolved };
  });
}

export async function ensureConversationLeadAndHandoff(input: {
  conversationId: string;
  reason: string;
  summary: string;
  kind?: string;
  priority?: number;
  source?: string;
  requestHandoff?: boolean;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))`;
    return ensureConversationLeadAndHandoffInTransaction(tx, input);
  });
}

async function ensureConversationLeadAndHandoffInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    conversationId: string;
    reason: string;
    summary: string;
    kind?: string;
    priority?: number;
    source?: string;
    requestHandoff?: boolean;
  },
) {
  const conversation = await tx.conversation.findUnique({
      where: { id: input.conversationId },
      include: { contact: true, episodes: { orderBy: { sequence: "desc" }, take: 1 } },
    });
    if (!conversation) throw new Error("Conversation not found.");
    const episode = conversation.episodes[0];
    if (
      conversation.state === "HUMAN_ACTIVE"
      || episode?.status === ConversationEpisodeStatus.HUMAN_ACTIVE
    ) {
      return {
        handoff: null,
        lead: null,
        skipped: "human_active" as const,
      };
    }
    const priority = Math.max(0, Math.min(100, Math.round(input.priority || 50)));
    const shouldRequestHandoff = input.requestHandoff !== false;
    const existingHandoff = shouldRequestHandoff
      ? await tx.handoffRequest.findFirst({
          where: {
            conversationId: conversation.id,
            status: { in: [HandoffStatus.OPEN, HandoffStatus.REVIEWING] },
          },
          orderBy: { createdAt: "desc" },
        })
      : null;
    const handoff = shouldRequestHandoff
      ? existingHandoff
        ? await tx.handoffRequest.update({
            where: { id: existingHandoff.id },
            data: {
              reason: input.reason,
              summary: input.summary,
              recommendedPriority: priority,
              recommendedOwnerAction: "Review the conversation and take over when appropriate.",
              ...(episode ? { episodeId: episode.id } : {}),
            },
          })
        : await tx.handoffRequest.create({
            data: {
              representativeId: conversation.representativeId,
              contactId: conversation.contactId,
              conversationId: conversation.id,
              ...(episode ? { episodeId: episode.id } : {}),
              reason: input.reason,
              summary: input.summary,
              recommendedPriority: priority,
              recommendedOwnerAction: "Review the conversation and take over when appropriate.",
            },
          })
      : null;

    const existingLead = await tx.lead.findFirst({
      where: {
        conversationId: conversation.id,
        status: { notIn: [LeadStatus.WON, LeadStatus.LOST, LeadStatus.ARCHIVED] },
      },
      orderBy: { updatedAt: "desc" },
    });
    const title = `${conversation.contact.displayName || conversation.contact.username || "New contact"} · ${input.kind || "inquiry"}`;
    const lead = existingLead
      ? await tx.lead.update({
          where: { id: existingLead.id },
          data: {
            ...(handoff ? { handoffRequestId: handoff.id } : {}),
            ...(episode ? { episodeId: episode.id } : {}),
            kind: input.kind || existingLead.kind,
            title,
            summary: input.summary,
            priority,
            status: LeadStatus.QUALIFIED,
            source: input.source || existingLead.source,
          },
        })
      : await tx.lead.create({
          data: {
            representativeId: conversation.representativeId,
            contactId: conversation.contactId,
            conversationId: conversation.id,
            ...(episode ? { episodeId: episode.id } : {}),
            ...(handoff ? { handoffRequestId: handoff.id } : {}),
            kind: input.kind || "general",
            title,
            summary: input.summary,
            priority,
            status: LeadStatus.QUALIFIED,
            source: input.source || conversation.sourceChannel || "conversation",
          },
        });

    if (shouldRequestHandoff && episode) {
      await tx.conversationEpisode.update({
        where: { id: episode.id },
        data: { status: ConversationEpisodeStatus.NEEDS_HUMAN },
      });
    }
    if (shouldRequestHandoff) {
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { state: "NEEDS_HUMAN" },
      });
    }
    await tx.contact.update({
      where: { id: conversation.contactId },
      data: { stage: "QUALIFIED" },
    });
    return { handoff, lead };
}

export async function assignConversationOperator(input: {
  representativeSlug: string;
  conversationId: string;
  operatorId: string;
  operatorName: string;
}) {
  return runConversationWriteTransaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))
    `;
    const conversation = await tx.conversation.findFirst({
      where: { id: input.conversationId, representative: { slug: input.representativeSlug } },
      include: { episodes: { orderBy: { sequence: "desc" }, take: 1 } },
    });
    if (!conversation) throw new Error("Conversation not found.");
    const episode = conversation.episodes[0];
    if (!episode) throw new Error("Conversation has no active episode.");
    assertConversationEpisodeTransition(episodeStateMap[episode.status], "human_active");

    const taskRows = await tx.delegationTask.findMany({
      where: {
        originConversationId: conversation.id,
        status: {
          notIn: [
            "COMPLETED",
            "FAILED",
            "CANCELED",
            "EXPIRED",
          ],
        },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const runRows = await tx.generationRun.findMany({
      where: {
        conversationId: conversation.id,
        OR: [
          {
            status: {
              in: [
                ...cancellableGenerationStatuses,
                GenerationRunStatus.FAILED,
              ],
            },
          },
          {
            status: GenerationRunStatus.COMPLETED,
            outputMessage: {
              is: {
                deliveryStatus: {
                  in: [
                    MessageDeliveryStatus.PROCESSING,
                    MessageDeliveryStatus.QUEUED,
                    MessageDeliveryStatus.FAILED,
                  ],
                },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        delegationTaskId: true,
        status: true,
        outputMessage: {
          select: { deliveryStatus: true },
        },
      },
      orderBy: { id: "asc" },
    });
    if (taskRows.length > 0) {
      throw new ActiveDelegationTaskControlError();
    }
    const runIds = runRows.map((run) => run.id).sort();
    for (const runId of runIds) {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${runId}))
      `;
    }
    const activeOutboxes = runIds.length
      ? await tx.outboxEvent.findMany({
          where: {
            aggregateType: "generation_run",
            aggregateId: { in: runIds },
            eventType: "generation.requested",
            status: { in: [...activeGenerationOutboxStatuses] },
          },
          select: {
            aggregateId: true,
            status: true,
            availableAt: true,
          },
        })
      : [];
    const takeoverAt = new Date();
    const inFlightRunIds = new Set(
      activeOutboxes
        .filter((event) =>
          event.status === "PROCESSING"
          && event.availableAt > takeoverAt
        )
        .map((event) => event.aggregateId),
    );
    if (
      runRows.some((run) =>
        inFlightRunIds.has(run.id)
        && (
          (
            run.status === GenerationRunStatus.COMPLETED
            && run.outputMessage?.deliveryStatus
              === MessageDeliveryStatus.PROCESSING
          )
          || Boolean(run.delegationTaskId)
        )
      )
    ) {
      throw new ConversationWorkInFlightControlError();
    }
    const runIdsWithActiveOutbox = new Set(
      activeOutboxes.map((event) => event.aggregateId),
    );
    for (const runId of runIds) {
      const run = await tx.generationRun.findUnique({
        where: { id: runId },
      });
      if (!run) continue;
      const interruptible = cancellableGenerationStatuses.includes(run.status)
        || (
          run.status === GenerationRunStatus.FAILED
          && runIdsWithActiveOutbox.has(run.id)
        )
        || (
          run.status === GenerationRunStatus.COMPLETED
          && runIdsWithActiveOutbox.has(run.id)
        );
      if (!interruptible) continue;
      await tx.outboxEvent.updateMany({
        where: {
          aggregateType: "generation_run",
          aggregateId: run.id,
          eventType: "generation.requested",
          status: { in: [...activeGenerationOutboxStatuses] },
        },
        data: {
          status: "PROCESSED",
          processedAt: takeoverAt,
          lastError: null,
        },
      });
      if (run.status === GenerationRunStatus.COMPLETED) {
        if (run.outputMessageId) {
          await tx.message.updateMany({
            where: {
              id: run.outputMessageId,
              deliveryStatus: {
                in: [
                  MessageDeliveryStatus.PROCESSING,
                  MessageDeliveryStatus.QUEUED,
                  MessageDeliveryStatus.FAILED,
                ],
              },
            },
            data: {
              deliveryStatus: MessageDeliveryStatus.CANCELED,
              failureCode: "operator_takeover_before_delivery",
              failureReason:
                "AI delivery was canceled because a human operator took control.",
            },
          });
        }
        continue;
      }
      if (run.status !== GenerationRunStatus.WAITING_HUMAN) {
        await releaseConversationEntitlementByGenerationRunId(
          {
            generationRunId: run.id,
            reason: "generation_deferred_for_human",
          },
          tx as unknown as ServiceEntitlementClient,
        );
      }
      const walletReservation = readGenerationWalletReservation(
        run.runtimePolicySnapshot,
      );
      let releasedSnapshot: Prisma.InputJsonObject | null = null;
      if (
        walletReservation
        && !run.delegationTaskId
        && run.status !== GenerationRunStatus.WAITING_HUMAN
      ) {
        await releaseConversationWalletUsage(
          {
            usageChargeId: walletReservation.usageChargeId,
            expectedGenerationRunId: run.id,
            reason: "generation_deferred_to_human",
            idempotencyKey: `generation:${run.id}:release`,
          },
          tx as unknown as UsageChargeClient,
        );
        releasedSnapshot = markGenerationWalletReleased(
          run.runtimePolicySnapshot,
          takeoverAt,
        );
      }
      const paused = await tx.generationRun.updateMany({
        where: {
          id: run.id,
          status: { in: [run.status] },
        },
        data: {
          status: GenerationRunStatus.WAITING_HUMAN,
          completedAt: null,
          canceledAt: null,
          ...(releasedSnapshot
            ? { runtimePolicySnapshot: releasedSnapshot }
            : {}),
        },
      });
      if (paused.count !== 1) {
        throw new Error(
          "Generation changed while the operator was taking control.",
        );
      }
      await tx.approvalRequest.updateMany({
        where: {
          generationRunId: run.id,
          status: "PENDING",
        },
        data: {
          status: "REJECTED",
          resolvedAt: takeoverAt,
          resolvedBy: input.operatorId,
          decisionNote: "A human operator took control of the conversation.",
        },
      });
      await tx.message.update({
        where: { id: run.inputMessageId },
        data: {
          deliveryStatus: MessageDeliveryStatus.SENT,
          failureCode: null,
          failureReason: null,
        },
      });
    }
    await tx.approvalRequest.updateMany({
      where: {
        conversationId: conversation.id,
        status: "PENDING",
      },
      data: {
        status: "REJECTED",
        resolvedAt: takeoverAt,
        resolvedBy: input.operatorId,
        decisionNote: "A human operator took control of the conversation.",
      },
    });

    await tx.conversationAssignment.updateMany({
      where: { conversationId: conversation.id, status: ConversationAssignmentStatus.ACTIVE },
      data: {
        status: ConversationAssignmentStatus.TRANSFERRED,
        releasedAt: takeoverAt,
        releaseReason: "operator_reassigned",
      },
    });
    const assignment = await tx.conversationAssignment.create({
      data: {
        conversationId: conversation.id,
        episodeId: episode.id,
        operatorId: input.operatorId,
        operatorName: input.operatorName,
      },
    });
    await tx.conversationEpisode.update({
      where: { id: episode.id },
      data: { status: ConversationEpisodeStatus.HUMAN_ACTIVE },
    });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { state: "HUMAN_ACTIVE", assignedOperatorId: input.operatorId },
    });
    await tx.handoffRequest.updateMany({
      where: {
        conversationId: conversation.id,
        status: { in: [HandoffStatus.OPEN, HandoffStatus.REVIEWING] },
      },
      data: { status: HandoffStatus.ACCEPTED },
    });
    await tx.lead.updateMany({
      where: {
        conversationId: conversation.id,
        status: { notIn: [LeadStatus.WON, LeadStatus.LOST, LeadStatus.ARCHIVED] },
      },
      data: {
        status: LeadStatus.FOLLOWING_UP,
        assignedOperatorId: input.operatorId,
        assignedOperatorName: input.operatorName,
      },
    });
    await tx.message.create({
      data: {
        conversationId: conversation.id,
        episodeId: episode.id,
        senderType: MessageSenderType.SYSTEM,
        contentType: MessageContentType.SYSTEM,
        text: `Human operator ${input.operatorName} joined the conversation.`,
        deliveryStatus: MessageDeliveryStatus.SENT,
        retentionExpiresAt: buildMessageRetentionExpiry(takeoverAt),
      },
    });
    await tx.conversationStateTransition.create({
      data: {
        conversationId: conversation.id,
        fromState: conversation.state,
        toState: "HUMAN_ACTIVE",
        reason: "operator_accepted_handoff",
        actorType: "operator",
        actorId: input.operatorId,
      },
    });
    return assignment;
  });
}

export async function returnConversationToAi(input: {
  representativeSlug: string;
  conversationId: string;
  operatorId: string;
  handoffSummary?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { id: input.conversationId, representative: { slug: input.representativeSlug } },
      include: { episodes: { orderBy: { sequence: "desc" }, take: 1 } },
    });
    if (!conversation) throw new Error("Conversation not found.");
    const episode = conversation.episodes[0];
    if (!episode) throw new Error("Conversation has no active episode.");
    assertConversationEpisodeTransition(episodeStateMap[episode.status], "active");

    await tx.conversationAssignment.updateMany({
      where: { conversationId: conversation.id, status: ConversationAssignmentStatus.ACTIVE },
      data: {
        status: ConversationAssignmentStatus.RELEASED,
        releasedAt: new Date(),
        releaseReason: "returned_to_ai",
      },
    });
    await tx.conversationEpisode.update({
      where: { id: episode.id },
      data: { status: ConversationEpisodeStatus.ACTIVE, summary: input.handoffSummary?.trim() || episode.summary },
    });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { state: "ACTIVE", assignedOperatorId: null },
    });
    await tx.handoffRequest.updateMany({
      where: { conversationId: conversation.id, status: HandoffStatus.ACCEPTED },
      data: { status: HandoffStatus.CLOSED },
    });
    await tx.message.create({
      data: {
        conversationId: conversation.id,
        episodeId: episode.id,
        senderType: MessageSenderType.SYSTEM,
        contentType: MessageContentType.SYSTEM,
        text: "The human operator returned this conversation to the digital representative.",
        deliveryStatus: MessageDeliveryStatus.SENT,
        retentionExpiresAt: buildMessageRetentionExpiry(new Date()),
      },
    });
    await tx.conversationStateTransition.create({
      data: {
        conversationId: conversation.id,
        fromState: conversation.state,
        toState: "ACTIVE",
        reason: "operator_returned_to_ai",
        actorType: "operator",
        actorId: input.operatorId,
      },
    });
    return { returnedToAi: true };
  });
}

export async function publishRepresentativeVersion(input: {
  representativeSlug: string;
  publishedBy: string;
  ownerId?: string;
  changeSummary?: string;
}) {
  const version = await prisma.$transaction(async (tx) => {
    const representative = await tx.representative.findUnique({
      where: { slug: input.representativeSlug },
      include: {
        knowledgePack: true,
        knowledgeAssetLinks: {
          where: {
            enabled: true,
            reviewStatus: KnowledgeAssetReviewStatus.APPROVED,
            asset: {
              status: KnowledgeAssetStatus.READY,
              archivedAt: null,
              checksum: { not: null },
            },
          },
          orderBy: { assetId: "asc" },
          select: {
            assetId: true,
            asset: {
              select: {
                checksum: true,
                processingVersion: true,
              },
            },
          },
        },
        pricingPlans: true,
        capabilityProfiles: {
          where: { isDefault: true, isManaged: false },
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { rules: true },
        },
        skillPackLinks: {
          include: {
            skillPack: true,
            workspaceInstall: {
              include: {
                releases: {
                  where: { status: WorkspaceSkillReleaseStatus.INSTALLED },
                  orderBy: { adoptedAt: "desc" },
                  take: 1,
                },
              },
            },
            mcpBindings: { select: { enabled: true } },
          },
        },
        mcpBindings: {
          orderBy: { createdAt: "asc" },
        },
        channelBindings: true,
      },
    });
    if (!representative) throw new Error("Representative not found.");

    const readiness = buildRepresentativeReadiness({
      displayName: representative.displayName,
      roleSummary: representative.roleSummary,
      tone: representative.tone,
      publicMode: representative.publicMode,
      humanInLoop: representative.humanInLoop,
      handoffPrompt: representative.handoffPrompt,
      knowledgeCount: representative.knowledgeAssetLinks.length,
      knowledgePackItemCount: countKnowledgePackItems(representative.knowledgePack),
      pricingCount: representative.pricingPlans.length,
      channelCount: representative.channelBindings.length,
      enabledSkillCount: representative.skillPackLinks.filter((link) => link.enabled).length,
      skillIssueCount: countRepresentativeSkillIssues(representative.skillPackLinks.filter((link) => link.enabled)),
    });
    const incomplete = readiness.filter((item) => !item.complete);
    if (incomplete.length) {
      throw new Error(`Representative is not publish-ready: ${incomplete.map((item) => item.label).join(", ")}.`);
    }

    const lastVersion = await tx.representativeVersion.findFirst({
      where: { representativeId: representative.id },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });
    const snapshot = buildRepresentativeSnapshot(representative);
    const version = await tx.representativeVersion.create({
      data: {
        representativeId: representative.id,
        versionNumber: (lastVersion?.versionNumber ?? 0) + 1,
        snapshot,
        changeSummary: input.changeSummary?.trim() || null,
        publishedBy: input.publishedBy,
      },
    });
    const syncRequestedAt = new Date();
    const syncJob = await tx.representativeContextSync.create({
      data: {
        representativeId: representative.id,
        requestedVersionId: version.id,
        trigger: "publish",
        requestedByOwnerId:
          input.ownerId === representative.ownerId
            ? representative.ownerId
            : null,
        status: "queued",
        itemCount: 0,
        attemptCount: 0,
        availableAt: syncRequestedAt,
        startedAt: syncRequestedAt,
      },
    });
    await tx.representative.update({
      where: { id: representative.id },
      data: {
        activeVersionId: version.id,
        lifecycleState: RepresentativeLifecycleState.PUBLISHED,
        openvikingLastSyncJobId: syncJob.id,
        openvikingLastSyncStatus: "queued",
        openvikingLastSyncError: null,
      },
    });
    if (representative.publicMode) {
      await tx.representativeChannelBinding.upsert({
        where: {
          representativeId_kind: {
            representativeId: representative.id,
            kind: RepresentativeChannelKind.WEB,
          },
        },
        create: {
          representativeId: representative.id,
          kind: RepresentativeChannelKind.WEB,
          transport: ChannelTransport.WEB,
          sourceProvider: ChannelSourceProvider.WEB,
          desiredState: ChannelDesiredState.ACTIVE,
          healthStatus: ChannelHealthStatus.HEALTHY,
          externalUserId: `/reps/${representative.slug}`,
          status: "CONNECTED",
          displayName: representative.displayName,
          configuration: { publicMode: true, source: "publish" },
        },
        update: {
          externalUserId: `/reps/${representative.slug}`,
          status: "CONNECTED",
          transport: ChannelTransport.WEB,
          sourceProvider: ChannelSourceProvider.WEB,
          displayName: representative.displayName,
        },
      });
    }
    await tx.eventAudit.create({
      data: {
        ...(input.ownerId === representative.ownerId
          ? { ownerId: representative.ownerId }
          : {}),
        representativeId: representative.id,
        type: "REPRESENTATIVE_VERSION_PUBLISHED",
        payload: {
          versionId: version.id,
          versionNumber: version.versionNumber,
          publishedBy: input.publishedBy,
          changeSummary: input.changeSummary?.trim() || null,
        },
      },
    });
    return version;
  });
  return version;
}

export async function activateRepresentativeVersion(input: {
  representativeSlug: string;
  versionId: string;
  activatedBy: string;
  ownerId?: string;
}) {
  const version = await prisma.$transaction(async (tx) => {
    const version = await tx.representativeVersion.findFirst({
      where: {
        id: input.versionId,
        representative: { slug: input.representativeSlug },
      },
      include: {
        representative: {
          select: {
            id: true,
            ownerId: true,
            activeVersionId: true,
            skillPackLinks: {
              where: { enabled: true },
              select: {
                id: true,
                skillPackId: true,
                installedVersion: true,
                workspaceInstall: {
                  select: {
                    status: true,
                    reviewStatus: true,
                    installedVersion: true,
                    releases: {
                      where: { status: WorkspaceSkillReleaseStatus.INSTALLED },
                      orderBy: { adoptedAt: "desc" },
                      take: 1,
                      select: {
                        version: true,
                        status: true,
                        executesCode: true,
                        registryTrustEligible: true,
                        signatureStatus: true,
                      },
                    },
                  },
                },
                skillPack: {
                  select: {
                    id: true,
                    source: true,
                    slug: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!version) throw new Error("Representative version not found.");
    const runtimeFilteredSkillIds = [
      ...new Set(
        readSnapshotSkillReleasePins(version.snapshot)
          .filter((pin) =>
            !version.representative.skillPackLinks.some((link) =>
              isRuntimeAvailableSkillLink(link, pin),
            ),
          )
          .map((pin) => pin.skillPackId),
      ),
    ];

    const syncRequestedAt = new Date();
    const syncJob = await tx.representativeContextSync.create({
      data: {
        representativeId: version.representative.id,
        requestedVersionId: version.id,
        trigger: "activate",
        requestedByOwnerId:
          input.ownerId === version.representative.ownerId
            ? version.representative.ownerId
            : null,
        status: "queued",
        itemCount: 0,
        attemptCount: 0,
        availableAt: syncRequestedAt,
        startedAt: syncRequestedAt,
      },
    });
    await tx.representative.update({
      where: { id: version.representative.id },
      data: {
        activeVersionId: version.id,
        lifecycleState: RepresentativeLifecycleState.PUBLISHED,
        openvikingLastSyncJobId: syncJob.id,
        openvikingLastSyncStatus: "queued",
        openvikingLastSyncError: null,
      },
    });
    await tx.eventAudit.create({
      data: {
        ...(input.ownerId === version.representative.ownerId
          ? { ownerId: version.representative.ownerId }
          : {}),
        representativeId: version.representative.id,
        type: "REPRESENTATIVE_VERSION_ACTIVATED",
        payload: {
          kind: "representative_version_activated",
          versionId: version.id,
          versionNumber: version.versionNumber,
          previousVersionId: version.representative.activeVersionId,
          activatedBy: input.activatedBy,
          runtimeFilteredSkillIds,
        },
      },
    });
    return {
      ...version,
      runtimeFilteredSkillIds,
    };
  });
  return version;
}

function buildRepresentativeSnapshot(representative: {
  displayName: string;
  roleSummary: string;
  tone: string;
  avatarUrl: string | null;
  publicMode: boolean;
  humanInLoop: boolean;
  groupActivation: string;
  languages: Prisma.JsonValue;
  freeReplyLimit: number;
  freeScope: Prisma.JsonValue;
  paywalledIntents: Prisma.JsonValue;
  handoffWindowHours: number;
  handoffPrompt: string;
  allowedSkills: Prisma.JsonValue;
  actionGate: Prisma.JsonValue;
  computeEnabled: boolean;
  computeDefaultPolicyMode: string;
  computeBaseImage: string;
  computeMaxSessionMinutes: number;
  computeAutoApproveBudgetCents: number;
  computeArtifactRetentionDays: number;
  computeNetworkMode: string;
  computeNetworkAllowlist: string[];
  computeFilesystemMode: string;
  delegationEnabled: boolean;
  delegationNaturalLanguageEnabled: boolean;
  delegationExplicitComputeEnabled: boolean;
  delegationMaxSteps: number;
  delegationMaxCostCents: number;
  delegationKnowledgeScope: string;
  knowledgePack: { identitySummary: string; faq: Prisma.JsonValue; materials: Prisma.JsonValue; policies: Prisma.JsonValue } | null;
  knowledgeAssetLinks: Array<{
    assetId: string;
    asset: {
      checksum: string | null;
      processingVersion: number;
    };
  }>;
  pricingPlans: Array<{ type: string; name: string; starsAmount: number; summary: string; includedReplies: number; includesPriorityHandoff: boolean }>;
  capabilityProfiles: Array<{
    defaultDecision: string;
    rules: Array<{
      id: string;
      capability: string;
      decision: string;
    }>;
  }>;
  skillPackLinks: Array<{
    id: string;
    enabled: boolean;
    installedVersion: string | null;
    skillPack: {
      id: string;
      slug: string;
      source: string;
      version: string | null;
    };
    workspaceInstall: {
      status: string;
      reviewStatus: string;
      releases: Array<{
        version: string;
        displayName: string;
        summary: string;
        sourceUrl: string | null;
        ownerHandle: string | null;
        verificationTier: string | null;
        capabilityTags: Prisma.JsonValue;
        executesCode: boolean;
        registryTrustEligible: boolean;
        signatureStatus: string;
      }>;
    } | null;
  }>;
  mcpBindings: Array<{
    id: string;
    representativeSkillPackLinkId: string | null;
    slug: string;
    serverUrl: string;
    transportKind: string;
    allowedToolNames: Prisma.JsonValue;
    defaultToolName: string | null;
    enabled: boolean;
    approvalRequired: boolean;
    estimatedCostCentsPerCall: number;
    maxRetries: number;
    retryBackoffMs: number;
  }>;
  channelBindings: Array<{ kind: string; status: string; externalUserId: string | null }>;
}): Prisma.InputJsonObject {
  const publishedSkillLinks = representative.skillPackLinks.flatMap((link) => {
    const install = link.workspaceInstall;
    const release = install?.releases[0];
    if (
      !link.enabled ||
      !install ||
      !release ||
      install.status === WorkspaceSkillInstallStatus.ARCHIVED ||
      (
        install.reviewStatus !== WorkspaceSkillReviewStatus.APPROVED
        && install.status !== WorkspaceSkillInstallStatus.UPDATE_AVAILABLE
      ) ||
      !isWorkspaceSkillReleaseRuntimeTrusted({
        source: link.skillPack.source,
        executesCode: release.executesCode,
        registryTrustEligible: release.registryTrustEligible,
        signatureStatus: release.signatureStatus,
      })
    ) {
      return [];
    }

    return [{
      linkId: link.id,
      snapshot: {
        id: link.skillPack.id,
        slug: link.skillPack.slug,
        displayName: release.displayName,
        source: link.skillPack.source.toLowerCase(),
        summary: release.summary,
        version: release.version,
        ...(release.sourceUrl ? { sourceUrl: release.sourceUrl } : {}),
        ...(release.ownerHandle ? { ownerHandle: release.ownerHandle } : {}),
        ...(release.verificationTier
          ? { verificationTier: release.verificationTier }
          : {}),
        capabilityTags: Array.isArray(release.capabilityTags)
          ? release.capabilityTags.filter((tag): tag is string => typeof tag === "string")
          : [],
        executesCode: false,
        enabled: true,
        installStatus: "installed",
      },
    }];
  });
  const publishedSkillLinkIds = new Set(publishedSkillLinks.map((link) => link.linkId));
  const publishedSkillReleasePins = new Map(
    publishedSkillLinks.map((link) => [
      link.linkId,
      {
        linkId: link.linkId,
        skillPackId: link.snapshot.id,
        source: link.snapshot.source,
        slug: link.snapshot.slug,
        version: link.snapshot.version,
      },
    ]),
  );
  const capabilityModes = resolveSnapshotCapabilityModes(
    representative.capabilityProfiles[0],
  );

  return {
    identity: {
      displayName: representative.displayName,
      roleSummary: representative.roleSummary,
      tone: representative.tone,
      avatarUrl: representative.avatarUrl,
      languages: representative.languages,
    },
    publicMode: representative.publicMode,
    humanInLoop: representative.humanInLoop,
    groupActivation: representative.groupActivation.toLowerCase(),
    conversation: {
      freeReplyLimit: representative.freeReplyLimit,
      freeScope: representative.freeScope,
      paywalledIntents: representative.paywalledIntents,
      handoffWindowHours: representative.handoffWindowHours,
      handoffPrompt: representative.handoffPrompt,
    },
    governance: {
      allowedSkills: representative.allowedSkills,
      actionGate: representative.actionGate,
    },
    compute: {
      enabled: representative.computeEnabled,
      defaultPolicyMode: representative.computeDefaultPolicyMode.toLowerCase(),
      baseImage: representative.computeBaseImage,
      maxSessionMinutes: representative.computeMaxSessionMinutes,
      autoApproveBudgetCents: representative.computeAutoApproveBudgetCents,
      artifactRetentionDays: representative.computeArtifactRetentionDays,
      networkMode: representative.computeNetworkMode.toLowerCase(),
      networkAllowlist: representative.computeNetworkAllowlist,
      filesystemMode: representative.computeFilesystemMode.toLowerCase(),
      capabilityModes,
    },
    delegation: {
      enabled: representative.delegationEnabled,
      naturalLanguageEnabled: representative.delegationNaturalLanguageEnabled,
      explicitComputeEnabled: representative.delegationExplicitComputeEnabled,
      maxSteps: representative.delegationMaxSteps,
      maxCostCents: representative.delegationMaxCostCents,
      knowledgeScope: representative.delegationKnowledgeScope.toLowerCase(),
    },
    knowledge: representative.knowledgePack
      ? {
          identitySummary: representative.knowledgePack.identitySummary,
          faq: representative.knowledgePack.faq,
          materials: representative.knowledgePack.materials,
          policies: representative.knowledgePack.policies,
        }
      : null,
    knowledgeAssets: representative.knowledgeAssetLinks.map((link) => ({
      assetId: link.assetId,
      checksum: link.asset.checksum,
      processingVersion: link.asset.processingVersion,
    })),
    pricing: representative.pricingPlans.map((plan) => ({
      tier: plan.type.toLowerCase(),
      name: plan.name,
      stars: plan.starsAmount,
      summary: plan.summary,
      includedReplies: plan.includedReplies,
      includesPriorityHandoff: plan.includesPriorityHandoff,
    })),
    skills: publishedSkillLinks.map((link) => link.snapshot),
    mcpBindings: representative.mcpBindings.flatMap((binding) => {
      if (
        !binding.enabled ||
        (
          binding.representativeSkillPackLinkId &&
          !publishedSkillLinkIds.has(binding.representativeSkillPackLinkId)
        )
      ) {
        return [];
      }

      return [{
        id: binding.id,
        slug: binding.slug,
        serverUrl: binding.serverUrl,
        transportKind: binding.transportKind.toLowerCase(),
        allowedToolNames: Array.isArray(binding.allowedToolNames)
          ? binding.allowedToolNames.filter((tool): tool is string => typeof tool === "string")
          : [],
        defaultToolName: binding.defaultToolName,
        enabled: true,
        approvalRequired: binding.approvalRequired,
        estimatedCostCentsPerCall: binding.estimatedCostCentsPerCall,
        maxRetries: binding.maxRetries,
        retryBackoffMs: binding.retryBackoffMs,
        skillReleasePin: binding.representativeSkillPackLinkId
          ? publishedSkillReleasePins.get(binding.representativeSkillPackLinkId)!
          : null,
      }];
    }),
    channels: representative.channelBindings.map((binding) => ({
      kind: binding.kind,
      status: binding.status,
      externalUserId: binding.externalUserId,
    })),
  };
}

function resolveSnapshotCapabilityModes(profile: {
  defaultDecision: string;
  rules: Array<{ id: string; capability: string; decision: string }>;
} | undefined): Record<
  "exec" | "read" | "write" | "process" | "browser" | "mcp",
  "allow" | "ask" | "deny"
> {
  const modes: Record<
    "exec" | "read" | "write" | "process" | "browser" | "mcp",
    "allow" | "ask" | "deny"
  > = {
    exec: "ask",
    read: "allow",
    write: "ask",
    process: "ask",
    browser: "ask",
    mcp: "ask",
  };
  if (!profile) return modes;

  for (const capability of Object.keys(modes) as Array<keyof typeof modes>) {
    const rule = profile.rules.find((candidate) =>
      candidate.id.endsWith(`_${capability}_owner_mode`),
    );
    const decision = rule?.decision.toLowerCase();
    if (decision === "allow" || decision === "ask" || decision === "deny") {
      modes[capability] = decision;
    }
  }
  return modes;
}

type SnapshotSkillReleasePin = {
  skillPackId: string;
  source: string;
  slug: string;
  version: string;
};

function isRuntimeAvailableSkillLink(link: {
  id: string;
  installedVersion: string | null;
  workspaceInstall: {
    status: string;
    reviewStatus: string;
    installedVersion: string | null;
    releases: Array<{
      version: string;
      status: string;
      executesCode: boolean;
      registryTrustEligible: boolean;
      signatureStatus: string;
    }>;
  } | null;
  skillPack: {
    id: string;
    source: string;
    slug: string;
  };
}, pin: SnapshotSkillReleasePin): boolean {
  const install = link.workspaceInstall;
  const release = install?.releases[0];
  return Boolean(
    install &&
    release &&
    link.skillPack.id === pin.skillPackId &&
    link.skillPack.source.toLowerCase() === pin.source &&
    link.skillPack.slug === pin.slug &&
    link.installedVersion === pin.version &&
    install.installedVersion === pin.version &&
    release.version === pin.version &&
    release.status === WorkspaceSkillReleaseStatus.INSTALLED &&
    install.status !== WorkspaceSkillInstallStatus.ARCHIVED &&
    (
      install.reviewStatus === WorkspaceSkillReviewStatus.APPROVED ||
      install.status === WorkspaceSkillInstallStatus.UPDATE_AVAILABLE
    ) &&
    isWorkspaceSkillReleaseRuntimeTrusted({
      source: link.skillPack.source,
      executesCode: release.executesCode,
      registryTrustEligible: release.registryTrustEligible,
      signatureStatus: release.signatureStatus,
    }),
  );
}

function readSnapshotSkillReleasePins(
  value: Prisma.JsonValue,
): SnapshotSkillReleasePin[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const skills = (value as Prisma.JsonObject).skills;
  if (!Array.isArray(skills)) return [];

  return skills.flatMap((skill) => {
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) return [];
    const record = skill as Prisma.JsonObject;
    const skillPackId =
      typeof record.id === "string" ? record.id.trim() : "";
    const source =
      typeof record.source === "string" ? record.source.trim().toLowerCase() : "";
    const slug =
      typeof record.slug === "string" ? record.slug.trim() : "";
    const version =
      typeof record.version === "string" ? record.version.trim() : "";
    return skillPackId && source && slug && version
      ? [{ skillPackId, source, slug, version }]
      : [];
  });
}

function normalizeChannel(value: string | null): "web" | "matrix" | "telegram" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "matrix") return "matrix";
  if (normalized === "telegram") return "telegram";
  return "web";
}

export function normalizeIanaTimeZone(value: string | null | undefined): string {
  const candidate = value?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return "UTC";
  }
}

function mapChannelKind(value: AcceptInboundMessageInput["channel"]): RepresentativeChannelKind {
  if (value === "matrix") return RepresentativeChannelKind.MATRIX;
  if (value === "telegram") return RepresentativeChannelKind.TELEGRAM;
  return RepresentativeChannelKind.WEB;
}

function resolveInboundMessageOccurredAt(input: AcceptInboundMessageInput) {
  if (input.channel !== "matrix" && input.channel !== "telegram") {
    return new Date();
  }
  if (!input.occurredAt) {
    throw new Error("Trusted provider event time is required for private channels.");
  }
  const timestamp = input.occurredAt.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("Trusted provider event time is invalid.");
  }
  const maximumClockSkewMilliseconds = 5 * 60 * 1_000;
  if (timestamp > Date.now() + maximumClockSkewMilliseconds) {
    throw new Error("Trusted provider event time is too far in the future.");
  }
  // This timestamp is retained for message chronology/display only. Private
  // memory authorization uses Message.ingressSequence and the immutable
  // disclosure activation boundary assigned by PostgreSQL.
  return new Date(timestamp);
}

function normalizeSenderType(value: MessageSenderType): ConversationInboxItem["lastSenderType"] {
  return value.toLowerCase() as ConversationInboxItem["lastSenderType"];
}

function legacyStateToEpisodeState(value: string): ConversationEpisodeState {
  const normalized = value.trim().toLowerCase();
  if (normalized === "human_active") return "human_active";
  if (normalized === "needs_human" || normalized === "waiting_on_owner") return "needs_human";
  if (normalized === "resolved" || normalized === "closed") return "resolved";
  if (normalized === "archived") return "archived";
  if (normalized === "failed") return "failed";
  if (normalized === "waiting_user") return "waiting_user";
  return "active";
}

function isConversationPlatformUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /does not exist|Unknown arg|Can't reach database server|connect ECONNREFUSED|P2021|P1001/i.test(
    error.message,
  );
}

function isRetryableMatrixIdentityBindingError(error: unknown): boolean {
  if (isConversationPlatformUnavailable(error)) return true;
  const code =
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
      ? error.code
      : "";
  if (["P1001", "P1002", "P1008", "P2024", "P2034"].includes(code)) {
    return true;
  }
  return error instanceof Error
    && /deadlock|transaction.*(?:conflict|timeout)|connection.*(?:closed|reset)|temporar(?:y|ily)/i.test(
      error.message,
    );
}

async function markMatrixInboxProcessed(
  id: string,
  client: Pick<Prisma.TransactionClient, "channelEventInbox"> = prisma,
) {
  await client.channelEventInbox.update({
    where: { id },
    data: {
      status: "PROCESSED",
      processedAt: new Date(),
      availableAt: new Date(),
      lastError: null,
    },
  });
}

async function deferMatrixInboxEvent(
  id: string,
  reason: string,
  client: Pick<Prisma.TransactionClient, "channelEventInbox"> = prisma,
) {
  await client.channelEventInbox.update({
    where: { id },
    data: {
      status: "FAILED",
      attemptCount: { decrement: 1 },
      processedAt: null,
      availableAt: new Date(Date.now() + matrixEventRetryDelayMs),
      lastError: reason,
    },
  });
}

function isMatrixMemorySafetyControlEvent(
  eventType: string,
  event: MatrixApplicationServiceEvent,
) {
  if (eventType === "m.room.redaction") return true;
  if (eventType !== "m.room.message") return false;
  const relatesTo = isJsonRecord(event.content?.["m.relates_to"])
    ? event.content?.["m.relates_to"]
    : null;
  return relatesTo?.rel_type === "m.replace";
}

function isMatrixSafetyTighteningMembershipEvent(
  event: MatrixApplicationServiceEvent,
) {
  if (event.type !== "m.room.member") return false;
  const membership = event.content?.membership;
  // Encryption, leave and ban events can only make a room less usable, so
  // processing them across an endpoint lifecycle is fail-safe. Invite, join
  // and knock events may create or reactivate access and therefore must prove
  // that they arrived in the current endpoint lifecycle.
  return membership === "leave" || membership === "ban";
}

async function consumeMatrixIdentityBindingChallenge(input: {
  guard: MatrixConversationMessageGuard;
  tokenHash: string;
  providerSubject: string;
  connectionId: string;
  matrixEventId: string;
}, tx: Prisma.TransactionClient) {
  if (!await lockAndVerifyMatrixDirectBinding(tx, {
    id: input.guard.channelBindingId,
    externalConversationId: input.guard.roomId,
    audienceMatrixUserId: input.guard.audienceMatrixUserId,
    representativeMatrixUserId:
      input.guard.representativeMatrixUserId,
  })) {
    throw new ChannelUnavailableError(
      "matrix_private_room_not_verified",
    );
  }
  return consumeIdentityBindingChallenge(
    {
      tokenHash: input.tokenHash,
      provider: privateChannelIdentityProviders.matrix,
      providerSubject: input.providerSubject,
      issuer: matrixHomeserverFromUserId(input.providerSubject),
      connectionId: input.connectionId,
      proofMetadata: {
        matrixRoomId: input.guard.roomId,
        matrixEventId: input.matrixEventId,
        directMessage: true,
      },
    },
    tx as never,
  );
}

/**
 * Matrix MVP deliberately supports only plaintext 1:1 rooms. A missing or
 * malformed safety marker is unsafe too: it may be a legacy/group binding, so
 * it must not reach the generation queue.
 */
function isMatrixDirectBindingSafe(metadata: unknown): boolean {
  if (!isJsonRecord(metadata)) return false;
  return metadata.directMessageOnly === true
    && metadata.encrypted === false
    && metadata.securityState === "ACTIVE"
    && typeof metadata.audienceMatrixUserId === "string"
    && typeof metadata.representativeMatrixUserId === "string";
}

function readMatrixRepresentativeUserId(
  metadata: unknown,
): string | null {
  if (!isJsonRecord(metadata)) return null;
  const matrixUserId = metadata.representativeMatrixUserId;
  return typeof matrixUserId === "string" ? matrixUserId : null;
}

function readMatrixRoomSecurityState(metadata: unknown): string | null {
  if (!isJsonRecord(metadata)) return null;
  return typeof metadata.securityState === "string"
    ? metadata.securityState
    : null;
}

function isTerminalMatrixAvailabilityCode(
  code: ChannelUnavailableError["code"],
): boolean {
  return (
    code === "representative_paused"
    || code === "representative_unpublished"
    || code === "representative_archived"
    || code === "channel_not_connected"
    || code === "channel_paused"
    || code === "channel_disconnected"
    || code === "channel_unhealthy"
    || code === "matrix_private_room_not_verified"
    || code === "matrix_identity_reassigned"
    || code === "matrix_channel_lifecycle_reactivated"
    || code === "identity_provenance_invalid"
    || code === "policy_disabled"
  );
}

async function lockAndVerifyMatrixDirectBinding(
  tx: Prisma.TransactionClient,
  binding: {
    id: string;
    externalConversationId: string;
    audienceMatrixUserId?: string;
    representativeMatrixUserId?: string;
  },
) {
  await lockMatrixRoomSecurityState(tx, binding.externalConversationId);
  const currentBinding = await tx.conversationChannelBinding.findFirst({
    where: {
      id: binding.id,
      kind: RepresentativeChannelKind.MATRIX,
      externalConversationId: binding.externalConversationId,
    },
    select: {
      kind: true,
      externalConversationId: true,
      representativeAssignmentRevision: true,
      metadata: true,
      representativeBinding: {
        select: {
          endpointAssignmentRevision: true,
        },
      },
    },
  });
  const safe = currentBinding?.kind === RepresentativeChannelKind.MATRIX
    && currentBinding.externalConversationId === binding.externalConversationId
    && isMatrixDirectBindingSafe(currentBinding.metadata);
  if (!safe || !isJsonRecord(currentBinding.metadata)) return false;
  const currentAssignmentRevision =
    currentBinding.representativeBinding
      ?.endpointAssignmentRevision ?? 0;
  if (
    currentAssignmentRevision <= 0
    || currentBinding.representativeAssignmentRevision
      !== currentAssignmentRevision
    || currentBinding.metadata.representativeAssignmentRevision
      !== currentAssignmentRevision
  ) {
    return false;
  }
  return (
    (
      binding.audienceMatrixUserId === undefined
      || currentBinding.metadata.audienceMatrixUserId
        === binding.audienceMatrixUserId
    )
    && (
      binding.representativeMatrixUserId === undefined
      || currentBinding.metadata.representativeMatrixUserId
        === binding.representativeMatrixUserId
    )
  );
}

function isExplicitMatrixDirectInvite(event: MatrixApplicationServiceEvent): boolean {
  return event.content?.is_direct === true;
}

type MatrixRoomMembershipUpdate = {
  isolated: boolean;
};

/**
 * Mirror Matrix membership evidence into the Conversation Platform. We cannot
 * safely infer a room's current member list from a single event, therefore any
 * unexpected member or either expected member leaving isolates the binding.
 * The bridge's post-join state check can later provide the positive proof that
 * the room contains exactly the two expected MXIDs.
 */
async function recordMatrixRoomMembership(input: {
  roomId: string;
  memberId: string;
  membership: string;
  eventId: string;
}): Promise<MatrixRoomMembershipUpdate | null> {
  return prisma.$transaction(async (tx) => {
    await lockMatrixRoomSecurityState(tx, input.roomId);
    const binding = await tx.conversationChannelBinding.findFirst({
      where: {
        kind: RepresentativeChannelKind.MATRIX,
        externalConversationId: input.roomId,
      },
      select: {
        id: true,
        conversationId: true,
        metadata: true,
      },
    });
    if (!binding) return null;

    const metadata = isJsonRecord(binding.metadata) ? binding.metadata : {};
    const audienceMatrixUserId = typeof metadata.audienceMatrixUserId === "string"
      ? metadata.audienceMatrixUserId
      : null;
    const representativeMatrixUserId = typeof metadata.representativeMatrixUserId === "string"
      ? metadata.representativeMatrixUserId
      : null;
    const expectedKind = input.memberId === audienceMatrixUserId
      ? ConversationParticipantKind.AUDIENCE
      : input.memberId === representativeMatrixUserId
        ? ConversationParticipantKind.REPRESENTATIVE
        : ConversationParticipantKind.SYSTEM;
    const isExpectedMember = expectedKind !== ConversationParticipantKind.SYSTEM;
    const remainsSafe = isExpectedMember && input.membership === "join";
    const now = new Date();
    const reason = !isMatrixDirectBindingSafe(metadata)
      ? "matrix_room_safety_metadata_missing"
      : !isExpectedMember
        ? "matrix_third_member_observed"
        : input.membership === "leave" || input.membership === "ban"
          ? "matrix_expected_member_left"
          : "matrix_unexpected_membership_state";

    await tx.conversationParticipant.upsert({
      where: {
        conversationId_kind_participantId: {
          conversationId: binding.conversationId,
          kind: expectedKind,
          participantId: input.memberId,
        },
      },
      create: {
        conversationId: binding.conversationId,
        kind: expectedKind,
        participantId: input.memberId,
        metadata: {
          provider: "MATRIX",
          matrixUserId: input.memberId,
          observedMembership: input.membership,
          ...(isExpectedMember ? {} : { untrustedMember: true }),
        },
        ...(remainsSafe ? {} : { leftAt: now }),
      },
      update: {
        ...(remainsSafe ? { leftAt: null } : { leftAt: now }),
        metadata: {
          provider: "MATRIX",
          matrixUserId: input.memberId,
          observedMembership: input.membership,
          ...(isExpectedMember ? {} : { untrustedMember: true }),
        },
      },
    });
    if (!remainsSafe) {
      await tx.conversation.update({
        where: { id: binding.conversationId },
        data: { state: "FAILED" },
      });
      await tx.conversationChannelBinding.update({
        where: { id: binding.id },
        data: {
          metadata: {
            ...metadata,
            securityState: "ISOLATED",
            encrypted: metadata.encrypted === true,
            isolationReason: reason,
            isolationEventId: input.eventId,
            isolatedAt: now.toISOString(),
          },
        },
      });
    }
    return { isolated: !remainsSafe };
  });
}

/** Called by the Application Service for a room-level encryption signal. */
export async function isolateMatrixConversationRoom(input: {
  roomId: string;
  reason: "matrix_room_encrypted" | "matrix_remote_room_validation_failed";
  eventId?: string;
  observedMemberId?: string;
}) {
  return prisma.$transaction(async (tx) => {
    await lockMatrixRoomSecurityState(tx, input.roomId);
    const binding = await tx.conversationChannelBinding.findFirst({
      where: {
        kind: RepresentativeChannelKind.MATRIX,
        externalConversationId: input.roomId,
      },
      select: { id: true, conversationId: true, metadata: true },
    });
    if (!binding) return false;

    const metadata = isJsonRecord(binding.metadata) ? binding.metadata : {};
    const now = new Date();
    if (input.observedMemberId) {
      await tx.conversationParticipant.upsert({
        where: {
          conversationId_kind_participantId: {
            conversationId: binding.conversationId,
            kind: ConversationParticipantKind.SYSTEM,
            participantId: input.observedMemberId,
          },
        },
        create: {
          conversationId: binding.conversationId,
          kind: ConversationParticipantKind.SYSTEM,
          participantId: input.observedMemberId,
          metadata: { provider: "MATRIX", matrixUserId: input.observedMemberId, untrustedMember: true },
        },
        update: {},
      });
    }
    await tx.conversation.update({
      where: { id: binding.conversationId },
      data: { state: "FAILED" },
    });
    await tx.conversationChannelBinding.update({
      where: { id: binding.id },
      data: {
        metadata: {
          ...metadata,
          securityState: "ISOLATED",
          encrypted:
            input.reason === "matrix_room_encrypted"
            || metadata.encrypted === true,
          isolationReason: input.reason,
          ...(input.eventId ? { isolationEventId: input.eventId } : {}),
          isolatedAt: now.toISOString(),
        },
      },
    });
    return true;
  });
}

/**
 * The bridge invokes this only after its homeserver read proves the exact
 * two-member, plaintext state. Keeping this separate from invite provisioning
 * makes a missing AS token/permission fail closed rather than best-effort.
 */
export async function activateVerifiedMatrixDirectConversation(input: {
  roomId: string;
  audienceMatrixUserId: string;
  representativeMatrixUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.conversationChannelBinding.findFirst({
      where: {
        kind: RepresentativeChannelKind.MATRIX,
        externalConversationId: input.roomId,
      },
      select: {
        conversation: {
          select: { representativeId: true },
        },
      },
    });
    if (!candidate) return false;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${`matrix-virtual-user:${candidate.conversation.representativeId}`})
      )
    `;
    await lockMatrixRoomSecurityState(tx, input.roomId);
    const binding = await tx.conversationChannelBinding.findFirst({
      where: {
        kind: RepresentativeChannelKind.MATRIX,
        externalConversationId: input.roomId,
      },
      select: {
        id: true,
        representativeAssignmentRevision: true,
        metadata: true,
        conversation: {
          select: { representativeId: true },
        },
        representativeBinding: {
          select: {
            desiredState: true,
            externalUserId: true,
            endpointAssignmentRevision: true,
            status: true,
          },
        },
      },
    });
    if (!binding || !isJsonRecord(binding.metadata)) return false;
    const virtualUser = await tx.matrixVirtualUserBinding.findUnique({
      where: {
        matrixUserId: input.representativeMatrixUserId,
      },
      select: {
        representativeId: true,
        kind: true,
        enabled: true,
      },
    });
    if (
      binding.conversation.representativeId
        !== candidate.conversation.representativeId
      || binding.representativeBinding?.desiredState
        !== ChannelDesiredState.ACTIVE
      || binding.representativeBinding.status === "DISCONNECTED"
      || binding.representativeBinding.externalUserId
        !== input.representativeMatrixUserId
      || binding.representativeBinding.endpointAssignmentRevision <= 0
      || binding.representativeAssignmentRevision
        !== binding.representativeBinding.endpointAssignmentRevision
      || binding.metadata.representativeAssignmentRevision
        !== binding.representativeBinding.endpointAssignmentRevision
      || virtualUser?.representativeId
        !== candidate.conversation.representativeId
      || virtualUser.kind !== "REPRESENTATIVE"
      || virtualUser.enabled !== true
    ) {
      return false;
    }
    const metadata = binding.metadata;
    if (
      metadata.directMessageOnly !== true
      || metadata.encrypted !== false
      || metadata.audienceMatrixUserId !== input.audienceMatrixUserId
      || metadata.representativeMatrixUserId !== input.representativeMatrixUserId
      || metadata.securityState !== "PENDING_REMOTE_VALIDATION"
    ) {
      return false;
    }
    await tx.conversationChannelBinding.update({
      where: { id: binding.id },
      data: {
        metadata: {
          ...metadata,
          securityState: "ACTIVE",
          verifiedAt: new Date().toISOString(),
          isolationReason: null,
        },
      },
    });
    return true;
  });
}

function isMatrixAudienceSenderAuthorized(input: {
  sender: string;
  contact: {
    id: string;
    channelUserId: string | null;
    externalUserId: string | null;
  };
  participants: Array<{
    kind: string;
    participantId: string;
    leftAt: Date | null;
    metadata: unknown;
  }>;
}) {
  const allowedSenderIds = new Set<string>();
  addMatrixSenderId(allowedSenderIds, input.contact.channelUserId);
  addMatrixSenderId(allowedSenderIds, input.contact.externalUserId);

  for (const participant of input.participants) {
    if (participant.kind !== "AUDIENCE" || participant.leftAt) continue;
    addMatrixSenderId(allowedSenderIds, participant.participantId);
    addMatrixSenderIdsFromMetadata(allowedSenderIds, participant.metadata);
  }

  return allowedSenderIds.has(input.sender);
}

function addMatrixSenderIdsFromMetadata(target: Set<string>, metadata: unknown) {
  if (!isJsonRecord(metadata)) return;
  for (const key of [
    "matrixUserId",
    "matrix_user_id",
    "audienceMatrixUserId",
    "channelUserId",
    "externalUserId",
  ]) {
    addMatrixSenderId(target, metadata[key]);
  }
  for (const key of ["matrixUserIds", "allowedSenderIds"]) {
    const values = metadata[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) addMatrixSenderId(target, value);
  }
}

function addMatrixSenderId(target: Set<string>, value: unknown) {
  if (typeof value !== "string") return;
  const normalized = value.trim();
  if (normalized) target.add(normalized);
}

function isMatrixMessageOwnedBySender(
  message: { senderId: string | null; senderType: MessageSenderType },
  sender: string,
) {
  return message.senderType === MessageSenderType.AUDIENCE && message.senderId === sender;
}

function parsePrivateChannelBindingCommand(body: string): string | null {
  const match = body.match(/^(?:!|\/)bind\s+([A-Za-z0-9_-]{32,128})$/);
  return match?.[1] ?? null;
}

async function resolveMatrixProviderArrivalFence(input: {
  roomId: string;
  managedMatrixUserId: string | null;
}): Promise<MatrixProviderArrivalFence | null> {
  const currentBinding = await loadCurrentMatrixArrivalBinding(input.roomId);
  const currentFence = buildMatrixProviderArrivalFence(
    currentBinding?.representativeBinding ?? null,
  );
  if (currentFence) return currentFence;
  if (!input.managedMatrixUserId) return null;

  // A direct invite and its first content may share one homeserver
  // transaction before the conversation binding exists. Resolve the managed
  // virtual user to the representative endpoint so every event in that room
  // receives the same immutable arrival lifecycle.
  const managedTarget = await prisma.matrixVirtualUserBinding.findUnique({
    where: { matrixUserId: input.managedMatrixUserId },
    select: {
      enabled: true,
      representativeId: true,
      matrixUserId: true,
      representative: {
        select: {
          channelBindings: {
            where: { kind: RepresentativeChannelKind.MATRIX },
            take: 1,
            select: {
              id: true,
              externalUserId: true,
              endpointAssignmentRevision: true,
              endpointLifecycleRevision: true,
              desiredState: true,
            },
          },
        },
      },
    },
  });
  const representativeBinding =
    managedTarget?.representative?.channelBindings[0];
  if (
    !managedTarget?.enabled
    || !managedTarget.representativeId
    || managedTarget.matrixUserId !== input.managedMatrixUserId
    || representativeBinding?.externalUserId !== input.managedMatrixUserId
  ) return null;
  return buildMatrixProviderArrivalFence(representativeBinding);
}

async function loadCurrentMatrixArrivalBinding(roomId: string) {
  return prisma.conversationChannelBinding.findFirst({
    where: {
      kind: RepresentativeChannelKind.MATRIX,
      externalConversationId: roomId,
    },
    select: {
      id: true,
      representativeBindingId: true,
      representativeAssignmentRevision: true,
      representativeBinding: {
        select: {
          id: true,
          endpointAssignmentRevision: true,
          endpointLifecycleRevision: true,
          desiredState: true,
        },
      },
    },
  });
}

async function loadCurrentMatrixArrivalEndpointBinding(bindingId: string) {
  return prisma.representativeChannelBinding.findUnique({
    where: { id: bindingId },
    select: {
      id: true,
      endpointAssignmentRevision: true,
      endpointLifecycleRevision: true,
      desiredState: true,
    },
  });
}

function buildMatrixProviderArrivalFence(
  binding: {
    id: string;
    endpointAssignmentRevision: number;
    endpointLifecycleRevision: number;
    desiredState: ChannelDesiredState;
  } | null | undefined,
): MatrixProviderArrivalFence | null {
  if (
    !binding?.id
    || !Number.isSafeInteger(binding.endpointAssignmentRevision)
    || binding.endpointAssignmentRevision <= 0
    || !Number.isSafeInteger(binding.endpointLifecycleRevision)
    || binding.endpointLifecycleRevision <= 0
  ) return null;
  return {
    version: 1,
    representativeBindingId: binding.id,
    endpointAssignmentRevision: binding.endpointAssignmentRevision,
    endpointLifecycleRevision: binding.endpointLifecycleRevision,
    arrivedDesiredState: binding.desiredState,
  };
}

function buildMatrixProviderArrivalPayload(
  event: MatrixApplicationServiceEvent,
  arrivalFence: MatrixProviderArrivalFence | null,
): Prisma.InputJsonObject {
  const providerEvent = stripMatrixProviderArrivalFence(event);
  return {
    ...providerEvent,
    ...(arrivalFence
      ? { [matrixProviderArrivalFencePayloadKey]: arrivalFence }
      : {}),
  } as Prisma.InputJsonObject;
}

function stripMatrixProviderArrivalFence(
  event: MatrixApplicationServiceEvent,
): MatrixApplicationServiceEvent {
  const {
    [matrixProviderArrivalFencePayloadKey]: _untrustedArrivalFence,
    ...providerEvent
  } = event;
  return providerEvent;
}

function sanitizeMatrixApplicationServiceEvent(
  event: MatrixApplicationServiceEvent,
): {
  event: MatrixApplicationServiceEvent;
  privateCredentialHash: string | null;
} {
  const providerEvent = stripMatrixProviderArrivalFence(event);
  if (
    providerEvent.type !== "m.room.message"
    || !isJsonRecord(providerEvent.content)
  ) {
    return { event: providerEvent, privateCredentialHash: null };
  }
  const content = removeMatrixBindingCredentialMetadata(providerEvent.content);
  if (!isJsonRecord(content)) {
    return {
      event: { ...providerEvent, content: {} },
      privateCredentialHash: null,
    };
  }
  const sanitizedWithoutCredential = { ...providerEvent, content };
  const msgtype = content.msgtype;
  if (msgtype !== "m.text") {
    return {
      event: sanitizedWithoutCredential,
      privateCredentialHash: null,
    };
  }
  const newContent = isJsonRecord(content["m.new_content"])
    ? content["m.new_content"]
    : null;
  const candidateBodies = [
    content.body,
    newContent?.body,
  ];
  const tokens = candidateBodies.flatMap((body) => {
    if (typeof body !== "string") return [];
    const token = parsePrivateChannelBindingCommand(body.trim());
    return token ? [token] : [];
  });
  if (tokens.length === 0) {
    return {
      event: sanitizedWithoutCredential,
      privateCredentialHash: null,
    };
  }
  const token = tokens[0]!;
  const sanitizedContent = redactMatrixBindingTokens(
    content,
    new Set(tokens),
  );
  if (!isJsonRecord(sanitizedContent)) {
    return {
      event: sanitizedWithoutCredential,
      privateCredentialHash: null,
    };
  }
  return {
    event: {
      ...event,
      content: {
        ...sanitizedContent,
        body: "!bind [redacted]",
      },
    },
    privateCredentialHash:
      createHash("sha256").update(token, "utf8").digest("hex"),
  };
}

function removeMatrixBindingCredentialMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => removeMatrixBindingCredentialMetadata(item));
  }
  if (!isJsonRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== matrixBindingTokenHashContentKey)
      .map(([key, nestedValue]) => [
        key,
        removeMatrixBindingCredentialMetadata(nestedValue),
      ]),
  );
}

function redactMatrixBindingTokens(
  value: unknown,
  tokens: ReadonlySet<string>,
): unknown {
  if (typeof value === "string") {
    let redacted = value;
    for (const token of tokens) {
      redacted = redacted.split(token).join("[redacted]");
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactMatrixBindingTokens(item, tokens));
  }
  if (!isJsonRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => {
      const redactedKey = redactMatrixBindingTokens(key, tokens);
      return [
        typeof redactedKey === "string" ? redactedKey : key,
        redactMatrixBindingTokens(nestedValue, tokens),
      ];
    }),
  );
}

function matrixHomeserverFromUserId(matrixUserId: string): string {
  return matrixServerNameFromUserId(matrixUserId);
}

export function readConversationGenerationRuntimeOutcome(
  contextSnapshot: unknown,
): ConversationGenerationRuntimeOutcome | undefined {
  if (!isJsonRecord(contextSnapshot)) return undefined;
  const outcome = contextSnapshot.runtimeOutcome;
  if (
    !isJsonRecord(outcome)
    || outcome.version !== 1
    || (outcome.mode !== "model" && outcome.mode !== "fallback")
  ) {
    return undefined;
  }
  if (outcome.mode === "model") return { mode: "model" };

  const fallbackReason =
    outcome.fallbackReason === "model_unavailable"
    || outcome.fallbackReason === "provider_failed"
    || outcome.fallbackReason === "policy_fallback"
      ? outcome.fallbackReason
      : undefined;
  return {
    mode: "fallback",
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTerminalDelegationTaskStepStatus(
  status: DelegationTaskStepStatus,
): boolean {
  return (
    status === DelegationTaskStepStatus.COMPLETED
    || status === DelegationTaskStepStatus.FAILED
    || status === DelegationTaskStepStatus.BLOCKED
    || status === DelegationTaskStepStatus.CANCELED
    || status === DelegationTaskStepStatus.SKIPPED
  );
}

function isNeedsHumanDeliveryAuthorized(
  content: unknown,
  generationRunId: string,
): boolean {
  if (!isJsonRecord(content)) return false;
  const deliveryControl = content.deliveryControl;
  return (
    isJsonRecord(deliveryControl)
    && deliveryControl.allowNeedsHuman === true
    && deliveryControl.generationRunId === generationRunId
  );
}

function buildDemoInboxSnapshot(representativeSlug: string): ConversationInboxSnapshot {
  return {
    representative: {
      id: "demo-representative",
      slug: representativeSlug,
      displayName: "Delegate Product Representative",
      timeZone: "UTC",
    },
    metrics: { unread: 3, needsHuman: 1, humanActive: 1, failed: 0, pending: 1, activeLeads: 2 },
    conversations: [
      {
        id: "demo-conversation-alex",
        contactName: "Alex Chen",
        contactHandle: "alex@example.com",
        channel: "matrix",
        state: "needs_human",
        episodeState: "needs_human",
        isPaid: true,
        unreadCount: 2,
        lastMessage: "Could we schedule a short call to discuss the partnership?",
        lastMessageAt: "2026-07-16T06:42:00.000Z",
        lastSenderType: "audience",
        needsHuman: true,
      },
      {
        id: "demo-conversation-mina",
        contactName: "Mina / Acme",
        channel: "web",
        state: "human_active",
        episodeState: "human_active",
        assignedOperatorName: "Neo",
        isPaid: true,
        unreadCount: 1,
        lastMessage: "Our budget is confirmed. Please send the final scope.",
        lastMessageAt: "2026-07-16T05:18:00.000Z",
        lastSenderType: "audience",
        needsHuman: true,
      },
      {
        id: "demo-conversation-visitor",
        contactName: "Visitor #184",
        channel: "web",
        state: "waiting_user",
        episodeState: "waiting_user",
        isPaid: false,
        unreadCount: 0,
        lastMessage: "I can help explain the available service packages.",
        lastMessageAt: "2026-07-16T03:52:00.000Z",
        lastSenderType: "representative",
        needsHuman: false,
      },
    ],
    pending: [
      {
        id: "demo-handoff-alex",
        conversationId: "demo-conversation-alex",
        contactName: "Alex Chen",
        reason: "Partnership follow-up",
        summary: "Requested a short call to discuss partnership scope.",
        priority: 80,
        status: "open",
        createdAt: "2026-07-16T06:42:00.000Z",
      },
    ],
    leads: [
      {
        id: "demo-lead-alex",
        conversationId: "demo-conversation-alex",
        contactName: "Alex Chen",
        title: "Alex Chen · partnership",
        summary: "Qualified partnership inquiry.",
        kind: "collaboration",
        status: "qualified",
        priority: 80,
        updatedAt: "2026-07-16T06:42:00.000Z",
      },
      {
        id: "demo-lead-mina",
        conversationId: "demo-conversation-mina",
        contactName: "Mina / Acme",
        title: "Mina / Acme · quote",
        kind: "pricing",
        status: "following_up",
        priority: 70,
        assignedOperatorName: "Neo",
        updatedAt: "2026-07-16T05:18:00.000Z",
      },
    ],
  };
}

function buildDemoConversationDetail(
  representativeSlug: string,
  conversationId: string,
): ConversationDetailSnapshot {
  const inbox = buildDemoInboxSnapshot(representativeSlug);
  const item = inbox.conversations.find((conversation) => conversation.id === conversationId) ?? inbox.conversations[0]!;
  return {
    id: item.id,
    contact: {
      id: `contact-${item.id}`,
      displayName: item.contactName,
      ...(item.contactHandle ? { username: item.contactHandle } : {}),
      stage: item.needsHuman ? "qualified" : "new",
      role: "partner",
      isPaid: item.isPaid,
    },
    representative: {
      slug: representativeSlug,
      displayName: inbox.representative.displayName,
    },
    channel: item.channel,
    state: item.state,
    episode: { id: `episode-${item.id}`, sequence: 2, status: item.episodeState, representativeVersion: 3 },
    ...(item.assignedOperatorName
      ? { assignment: { operatorId: "demo-operator", operatorName: item.assignedOperatorName } }
      : {}),
    messages: [
      {
        id: "demo-message-1",
        senderType: "audience",
        senderDisplayName: item.contactName,
        text: "We are evaluating Delegate for our partner support workflow.",
        status: "sent",
        createdAt: "2026-07-16T05:55:00.000Z",
        citations: [],
      },
      {
        id: "demo-message-2",
        senderType: "representative",
        senderDisplayName: inbox.representative.displayName,
        text: "Delegate can combine a public representative, governed knowledge, and explicit human handoff in one workflow.",
        status: "sent",
        createdAt: "2026-07-16T05:55:08.000Z",
        citations: [
          {
            title: "Delegate service overview",
            excerpt: "Public-facing representatives operate inside explicit knowledge and action boundaries.",
          },
        ],
      },
      {
        id: "demo-message-3",
        senderType: "audience",
        senderDisplayName: item.contactName,
        text: item.lastMessage,
        status: "sent",
        createdAt: item.lastMessageAt,
        citations: [],
      },
    ],
    runs: [
      {
        id: "demo-run-1",
        status: item.needsHuman ? "waiting_human" : "completed",
        model: "gpt-5-mini",
        createdAt: item.lastMessageAt,
      },
    ],
    tasks: [],
    notes: [],
  };
}

function countRepresentativeSkillIssues(links: Array<{
  skillPack: { source: string };
  workspaceInstall: {
    status: string;
    reviewStatus: string;
    releases: Array<{
      capabilityTags: Prisma.JsonValue;
      executesCode: boolean;
      registryTrustEligible: boolean;
      signatureStatus: string;
    }>;
  } | null;
  mcpBindings: Array<{ enabled: boolean }>;
}>): number {
  return links.filter((link) => {
    const installedRelease = link.workspaceInstall?.releases[0];
    if (
      !link.workspaceInstall
      || !installedRelease
      || !isWorkspaceSkillReleaseRuntimeTrusted({
        source: link.skillPack.source,
        executesCode: installedRelease.executesCode,
        registryTrustEligible: installedRelease.registryTrustEligible,
        signatureStatus: installedRelease.signatureStatus,
      })
    ) return true;
    if (link.workspaceInstall.status === "ARCHIVED") return true;
    if (link.workspaceInstall.reviewStatus !== "APPROVED" && link.workspaceInstall.status !== "UPDATE_AVAILABLE") return true;
    const tags = Array.isArray(installedRelease.capabilityTags)
      ? installedRelease.capabilityTags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.toLowerCase())
      : [];
    const requiresMcp = tags.some((tag) => tag === "mcp" || tag.startsWith("mcp-") || tag.endsWith("-mcp"));
    return requiresMcp && !link.mcpBindings.some((binding) => binding.enabled);
  }).length;
}

export function buildRepresentativeReadiness(input: {
  displayName: string;
  roleSummary: string;
  tone: string;
  publicMode: boolean;
  humanInLoop: boolean;
  handoffPrompt: string;
  knowledgeCount: number;
  knowledgePackItemCount: number;
  pricingCount: number;
  channelCount: number;
  enabledSkillCount: number;
  skillIssueCount: number;
}): RepresentativeOperationsSnapshot["readiness"] {
  return [
    {
      id: "identity",
      label: "Identity and role",
      complete: Boolean(input.displayName.trim() && input.roleSummary.trim() && input.tone.trim()),
      detail: "Name, role summary, and response tone are configured.",
    },
    {
      id: "knowledge",
      label: "Knowledge scope",
      complete: input.knowledgeCount > 0 || input.knowledgePackItemCount > 0,
      detail: "At least one reviewed source or knowledge pack is available.",
    },
    {
      id: "handoff",
      label: "Human handoff",
      complete: !input.humanInLoop || Boolean(input.handoffPrompt.trim()),
      detail: "The owner intervention path is explicit.",
    },
    {
      id: "pricing",
      label: "Pricing and free scope",
      complete: input.pricingCount === 4,
      detail: "Free, pass, deep help, and sponsor tiers are configured independently from CNY service packages.",
    },
    {
      id: "skills",
      label: "Skills and tools",
      complete: input.skillIssueCount === 0,
      detail: input.skillIssueCount
        ? `${input.skillIssueCount} enabled skill binding(s) have unresolved governance or connection requirements.`
        : `${input.enabledSkillCount} enabled skill binding(s) satisfy the current governance checks.`,
    },
    {
      id: "channel",
      label: "Published channel",
      complete: input.channelCount > 0 || input.publicMode,
      detail: "At least one public or connected channel is enabled.",
    },
  ];
}

function buildDemoRepresentativeOperations(representativeSlug: string): RepresentativeOperationsSnapshot {
  return {
    representative: {
      id: "demo-representative",
      slug: representativeSlug,
      displayName: "Delegate Product Representative",
      roleSummary: "Explains Delegate, qualifies requests, and escalates high-value conversations.",
      lifecycleState: "published",
      publicMode: true,
      activeVersion: 3,
      timeZone: "UTC",
      updatedAt: "2026-07-16T06:00:00.000Z",
    },
    readiness: buildRepresentativeReadiness({
      displayName: "Delegate Product Representative",
      roleSummary: "Product representative",
      tone: "Clear and direct",
      publicMode: true,
      humanInLoop: true,
      handoffPrompt: "Offer a human introduction when intent is qualified.",
      knowledgeCount: 12,
      knowledgePackItemCount: 5,
      pricingCount: 4,
      channelCount: 3,
      enabledSkillCount: 2,
      skillIssueCount: 0,
    }),
    channels: [
      { kind: "web", status: "connected", externalUserId: `/reps/${representativeSlug}` },
      { kind: "matrix", status: "ready", externalUserId: "@_delegate_rep_demo:delegate.local" },
      { kind: "telegram", status: "connected", externalUserId: "@delegate_demo_bot" },
    ],
    versions: [
      {
        id: "version-3",
        versionNumber: 3,
        changeSummary: "Clarified service boundaries and handoff policy.",
        publishedBy: "Neo",
        publishedAt: "2026-07-16T05:42:00.000Z",
        active: true,
      },
      {
        id: "version-2",
        versionNumber: 2,
        changeSummary: "Added reviewed product knowledge.",
        publishedBy: "Neo",
        publishedAt: "2026-07-12T03:10:00.000Z",
        active: false,
      },
    ],
    metrics: { conversations: 18, knowledgeAssets: 12, enabledSkills: 6, openHandoffs: 2 },
  };
}

function countKnowledgePackItems(
  knowledgePack: { faq: Prisma.JsonValue; materials: Prisma.JsonValue; policies: Prisma.JsonValue } | null,
): number {
  if (!knowledgePack) return 0;
  return [knowledgePack.faq, knowledgePack.materials, knowledgePack.policies].reduce<number>(
    (total, value) => total + (Array.isArray(value) ? value.length : 0),
    0,
  );
}
