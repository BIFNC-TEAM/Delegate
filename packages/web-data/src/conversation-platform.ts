import {
  ConversationAssignmentStatus,
  ConversationEpisodeStatus,
  GenerationRunStatus,
  HandoffStatus,
  LeadStatus,
  MessageContentType,
  MessageDeliveryStatus,
  MessageSenderType,
  Prisma,
  RepresentativeChannelKind,
  RepresentativeLifecycleState,
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

import { prisma } from "./prisma";

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
    citations: Array<{ title: string; excerpt?: string; uri?: string }>;
  }>;
  runs: Array<{
    id: string;
    status: string;
    model?: string;
    errorMessage?: string;
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
  senderDisplayName?: string;
  clientMessageId: string;
  channel?: "web" | "matrix" | "telegram";
  externalMessageId?: string;
};

export type MatrixApplicationServiceEvent = {
  event_id?: string;
  type?: string;
  room_id?: string;
  sender?: string;
  origin_server_ts?: number;
  redacts?: string;
  content?: Record<string, unknown>;
};

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

export async function listConversationInboxSnapshot(
  representativeSlug: string,
  operatorId = "local-owner",
): Promise<ConversationInboxSnapshot | null> {
  if (!process.env.DATABASE_URL?.trim()) {
    return buildDemoInboxSnapshot(representativeSlug);
  }

  try {
    const representative = await prisma.representative.findUnique({
      where: { slug: representativeSlug },
      select: { id: true, slug: true, displayName: true },
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
      representative,
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
      return buildDemoInboxSnapshot(representativeSlug);
    }
    throw error;
  }
}

export async function getConversationDetailSnapshot(
  representativeSlug: string,
  conversationId: string,
): Promise<ConversationDetailSnapshot | null> {
  if (!process.env.DATABASE_URL?.trim()) {
    return buildDemoConversationDetail(representativeSlug, conversationId);
  }

  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, representative: { slug: representativeSlug } },
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
            ...(citation.uri ? { uri: citation.uri } : {}),
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
      runs: conversation.generationRuns.map((run) => ({
        id: run.id,
        status: run.status.toLowerCase(),
        ...(run.model ? { model: run.model } : {}),
        ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
        createdAt: run.createdAt.toISOString(),
      })),
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
      return buildDemoConversationDetail(representativeSlug, conversationId);
    }
    throw error;
  }
}

export async function getRepresentativeOperationsSnapshot(
  representativeSlug: string,
): Promise<RepresentativeOperationsSnapshot | null> {
  if (!process.env.DATABASE_URL?.trim()) {
    return buildDemoRepresentativeOperations(representativeSlug);
  }

  try {
    const representative = await prisma.representative.findUnique({
      where: { slug: representativeSlug },
      include: {
        activeVersion: { select: { id: true, versionNumber: true } },
        versions: { orderBy: { versionNumber: "desc" }, take: 20 },
        channelBindings: { orderBy: { kind: "asc" } },
        knowledgeAssetLinks: { where: { enabled: true } },
        skillPackLinks: { where: { enabled: true } },
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
      return buildDemoRepresentativeOperations(representativeSlug);
    }
    throw error;
  }
}

export async function acceptInboundConversationMessage(input: AcceptInboundMessageInput) {
  const text = input.text.trim();
  if (!text) throw new Error("Message text is required.");
  if (!input.clientMessageId.trim()) throw new Error("clientMessageId is required.");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))`;
    const conversation = await tx.conversation.findFirst({
      where: { id: input.conversationId, representative: { slug: input.representativeSlug } },
      include: {
        representative: { select: { id: true, activeVersionId: true } },
        episodes: { orderBy: { sequence: "desc" }, take: 1 },
        channelBindings: true,
      },
    });
    if (!conversation) throw new Error("Conversation not found.");

    const latestEpisode = conversation.episodes[0];
    const latestState = latestEpisode ? episodeStateMap[latestEpisode.status] : "active";
    const action = resolveInboundEpisodeAction(latestState);
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
    }

    const channelKind = mapChannelKind(input.channel);
    const binding = conversation.channelBindings.find((item) => item.kind === channelKind);
    const createdAt = new Date();
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
        senderType: MessageSenderType.AUDIENCE,
        ...(input.senderId ? { senderId: input.senderId } : {}),
        ...(input.senderDisplayName ? { senderDisplayName: input.senderDisplayName } : {}),
        contentType: MessageContentType.TEXT,
        text,
        clientMessageId: input.clientMessageId,
        ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
        deliveryStatus: MessageDeliveryStatus.QUEUED,
        retentionExpiresAt: buildMessageRetentionExpiry(createdAt),
        createdAt,
      },
      update: {},
    });

    const shouldQueueAi = action !== "hold_for_operator";
    const run = shouldQueueAi
      ? await tx.generationRun.upsert({
          where: { idempotencyKey: `reply:${conversation.id}:${input.clientMessageId}` },
          create: {
            conversationId: conversation.id,
            episodeId: episode.id,
            inputMessageId: message.id,
            representativeVersionId: conversation.representative.activeVersionId,
            status: GenerationRunStatus.QUEUED,
            idempotencyKey: `reply:${conversation.id}:${input.clientMessageId}`,
          },
          update: {},
        })
      : null;

    if (run) {
      await tx.outboxEvent.upsert({
        where: { idempotencyKey: `generation.requested:${run.id}` },
        create: {
          conversationId: conversation.id,
          aggregateType: "generation_run",
          aggregateId: run.id,
          eventType: "generation.requested",
          payload: { runId: run.id, conversationId: conversation.id, messageId: message.id },
          idempotencyKey: `generation.requested:${run.id}`,
        },
        update: {},
      });
    }

    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        activeEpisodeId: episode.id,
        state: action === "hold_for_operator" ? "HUMAN_ACTIVE" : "AI_QUEUED",
        unreadCount: { increment: 1 },
        lastMessageAt: createdAt,
      },
    });

    return { message, run, heldForOperator: !shouldQueueAi };
  });
}

export async function completeInlineGenerationRun(input: {
  runId: string;
  replyText: string;
  senderDisplayName: string;
  intent?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costCents?: number;
  completeOutbox?: boolean;
  countUsage?: boolean;
  attachments?: Array<{
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    artifactId: string;
    url: string;
  }>;
  citations?: Array<{
    knowledgeAssetId?: string;
    title: string;
    excerpt?: string;
    score?: number;
  }>;
}) {
  const replyText = input.replyText.trim();
  if (!replyText) throw new Error("Reply text is required.");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.runId}))`;
    const run = await tx.generationRun.findUnique({
      where: { id: input.runId },
      include: { outputMessage: true },
    });
    if (!run) throw new Error("Generation run not found.");
    if (run.status === GenerationRunStatus.COMPLETED && run.outputMessage) {
      return { run, message: run.outputMessage };
    }
    if (run.status === GenerationRunStatus.CANCELED) {
      throw new Error("Generation run was canceled.");
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
        ...(input.intent ? { content: { intent: input.intent } } : {}),
        deliveryStatus: MessageDeliveryStatus.SENT,
        retentionExpiresAt: buildMessageRetentionExpiry(now),
        createdAt: now,
        ...(input.citations?.length
          ? {
              citations: {
                create: input.citations.map((citation) => ({
                  ...(citation.knowledgeAssetId ? { knowledgeAssetId: citation.knowledgeAssetId } : {}),
                  title: citation.title,
                  ...(citation.excerpt ? { excerpt: citation.excerpt } : {}),
                  ...(citation.score !== undefined ? { score: citation.score } : {}),
                })),
              },
            }
          : {}),
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
        startedAt: run.startedAt || now,
        completedAt: now,
        errorCode: null,
        errorMessage: null,
      },
    });
    await tx.message.update({
      where: { id: run.inputMessageId },
      data: { deliveryStatus: MessageDeliveryStatus.SENT },
    });
    await tx.conversation.update({
      where: { id: run.conversationId },
      data: {
        state: "WAITING_USER",
        lastMessageAt: now,
        ...(input.countUsage === false ? {} : { freeRepliesUsed: { increment: 1 } }),
      },
    });
    await tx.conversationEpisode.updateMany({
      where: { id: run.episodeId || "__no_episode__" },
      data: { status: ConversationEpisodeStatus.WAITING_USER },
    });
    if (input.completeOutbox !== false) {
      await tx.outboxEvent.updateMany({
        where: {
          aggregateType: "generation_run",
          aggregateId: run.id,
          status: { in: ["PENDING", "PROCESSING"] },
        },
        data: { status: "PROCESSED", processedAt: now },
      });
    }
    return { run: completed, message };
  });
}

export async function waitGenerationRunForComputeApproval(input: {
  runId: string;
  approvalId: string;
  replyText: string;
  senderDisplayName: string;
}) {
  const replyText = input.replyText.trim();
  if (!replyText) throw new Error("Approval waiting reply text is required.");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.runId}))`;
    const run = await tx.generationRun.findUnique({
      where: { id: input.runId },
      include: { outputMessage: true },
    });
    if (!run) throw new Error("Generation run not found.");
    if (run.status === GenerationRunStatus.COMPLETED && run.outputMessage) {
      return { run, message: run.outputMessage };
    }
    if (run.status === GenerationRunStatus.WAITING_APPROVAL && run.outputMessage) {
      return { run, message: run.outputMessage };
    }
    if (run.status === GenerationRunStatus.CANCELED) {
      throw new Error("Generation run was canceled.");
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
    await tx.outboxEvent.updateMany({
      where: {
        aggregateType: "generation_run",
        aggregateId: run.id,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      data: { status: "PROCESSED", processedAt: now },
    });
    return { run: waitingRun, message };
  });
}

export type ClaimedGenerationWorkItem = {
  outboxId: string;
  runId: string;
  representativeVersionId: string | null;
  representativeSlug: string;
  representativeName: string;
  conversationId: string;
  contactId: string;
  controlState: string;
  episodeId?: string;
  inputMessageId: string;
  userText: string;
  channel: "web" | "matrix" | "telegram";
  externalConversationId?: string;
  matrixSenderUserId?: string;
  usage: {
    freeRepliesUsed: number;
    passUnlocked: boolean;
    deepHelpUnlocked: boolean;
  };
};

export async function claimNextGenerationWorkItem(): Promise<ClaimedGenerationWorkItem | null> {
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "OutboxEvent"
      WHERE "status" IN ('PENDING', 'FAILED')
        AND "eventType" = 'generation.requested'
        AND "availableAt" <= NOW()
        AND "attemptCount" < 5
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const outboxId = candidates[0]?.id;
    if (!outboxId) return null;

    const outbox = await tx.outboxEvent.update({
      where: { id: outboxId },
      data: { status: "PROCESSING", attemptCount: { increment: 1 }, lastError: null },
    });
    const runId = outbox.aggregateId;
    const run = await tx.generationRun.findUnique({
      where: { id: runId },
      include: {
        inputMessage: true,
        conversation: {
          include: {
            representative: {
              select: { slug: true, displayName: true },
            },
            channelBindings: true,
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
    if (run.status === GenerationRunStatus.COMPLETED || run.status === GenerationRunStatus.CANCELED) {
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
      return null;
    }

    const matrixBinding = run.conversation.channelBindings.find(
      (binding) => binding.kind === RepresentativeChannelKind.MATRIX,
    );
    const telegramBinding = run.conversation.channelBindings.find(
      (binding) => binding.kind === RepresentativeChannelKind.TELEGRAM,
    );
    const channel = matrixBinding ? "matrix" : telegramBinding ? "telegram" : "web";
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

    return {
      outboxId: outbox.id,
      runId: run.id,
      representativeVersionId: run.representativeVersionId,
      representativeSlug: run.conversation.representative.slug,
      representativeName: run.conversation.representative.displayName,
      conversationId: run.conversationId,
      contactId: run.conversation.contactId,
      controlState: run.conversation.state,
      ...(run.episodeId ? { episodeId: run.episodeId } : {}),
      inputMessageId: run.inputMessageId,
      userText: run.inputMessage.text || "",
      channel,
      ...(matrixBinding ? { externalConversationId: matrixBinding.externalConversationId } : {}),
      ...(matrixVirtualUser ? { matrixSenderUserId: matrixVirtualUser.matrixUserId } : {}),
      usage: {
        freeRepliesUsed: run.conversation.freeRepliesUsed,
        passUnlocked: Boolean(run.conversation.passUnlockedAt),
        deepHelpUnlocked: Boolean(run.conversation.deepHelpUnlockedAt),
      },
    };
  });
}

export async function loadGenerationRecentTurns(input: {
  conversationId: string;
  beforeMessageId: string;
  limit?: number;
}) {
  const before = await prisma.message.findUnique({
    where: { id: input.beforeMessageId },
    select: { createdAt: true },
  });
  const rows = await prisma.message.findMany({
    where: {
      conversationId: input.conversationId,
      redactedAt: null,
      text: { not: null },
      ...(before ? { createdAt: { lt: before.createdAt } } : {}),
      senderType: { in: [MessageSenderType.AUDIENCE, MessageSenderType.REPRESENTATIVE, MessageSenderType.OPERATOR] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit || 10,
    select: { senderType: true, text: true },
  });
  return rows.reverse().map((message) => ({
    direction: message.senderType === MessageSenderType.AUDIENCE ? ("inbound" as const) : ("outbound" as const),
    messageText: message.text || "",
  }));
}

export async function deferGenerationRunForHuman(runId: string) {
  const run = await prisma.generationRun.update({
    where: { id: runId },
    data: { status: GenerationRunStatus.WAITING_HUMAN },
  });
  await prisma.outboxEvent.updateMany({
    where: { aggregateType: "generation_run", aggregateId: run.id },
    data: { status: "PROCESSED", processedAt: new Date() },
  });
  return run;
}

export async function markGenerationDeliveryComplete(input: {
  runId: string;
  outputMessageId: string;
  externalMessageId?: string;
}) {
  await prisma.$transaction([
    prisma.message.update({
      where: { id: input.outputMessageId },
      data: {
        deliveryStatus: MessageDeliveryStatus.SENT,
        ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
      },
    }),
    prisma.outboxEvent.updateMany({
      where: { aggregateType: "generation_run", aggregateId: input.runId },
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
    }),
  ]);
}

export async function retryGenerationDelivery(input: {
  runId: string;
  outputMessageId?: string;
  errorMessage: string;
}) {
  const outbox = await prisma.outboxEvent.findFirst({
    where: { aggregateType: "generation_run", aggregateId: input.runId },
    select: { attemptCount: true },
  });
  const deadLetter = (outbox?.attemptCount || 0) >= 5;
  await prisma.$transaction([
    ...(input.outputMessageId
      ? [
          prisma.message.update({
            where: { id: input.outputMessageId },
            data: {
              deliveryStatus: MessageDeliveryStatus.FAILED,
              failureCode: "channel_delivery_failed",
              failureReason: input.errorMessage,
            },
          }),
        ]
      : []),
    prisma.outboxEvent.updateMany({
      where: { aggregateType: "generation_run", aggregateId: input.runId },
      data: {
        status: deadLetter ? "DEAD_LETTER" : "FAILED",
        lastError: input.errorMessage,
        availableAt: new Date(Date.now() + Math.min(60_000, 2 ** (outbox?.attemptCount || 1) * 1000)),
      },
    }),
  ]);
}

export type ClaimedOperatorMessageWorkItem = {
  outboxId: string;
  messageId: string;
  text: string;
  operatorName: string;
  channel: "matrix" | "telegram";
  externalConversationId: string;
  matrixSenderUserId?: string;
};

export async function claimNextOperatorMessageWorkItem(): Promise<ClaimedOperatorMessageWorkItem | null> {
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "OutboxEvent"
      WHERE "status" IN ('PENDING', 'FAILED')
        AND "eventType" = 'operator.message.requested'
        AND "availableAt" <= NOW()
        AND "attemptCount" < 5
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const outboxId = candidates[0]?.id;
    if (!outboxId) return null;
    const outbox = await tx.outboxEvent.update({
      where: { id: outboxId },
      data: { status: "PROCESSING", attemptCount: { increment: 1 }, lastError: null },
    });
    const message = await tx.message.findUnique({
      where: { id: outbox.aggregateId },
      include: {
        channelBinding: true,
        conversation: { include: { representative: { select: { ownerId: true } } } },
      },
    });
    if (!message?.channelBinding || !message.text) {
      await tx.outboxEvent.update({
        where: { id: outbox.id },
        data: { status: "DEAD_LETTER", lastError: "operator_message_or_channel_missing" },
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
    const operatorVirtualUser = channel === "matrix"
      ? await tx.matrixVirtualUserBinding.findFirst({
          where: {
            ownerId: message.conversation.representative.ownerId,
            kind: "OPERATOR",
            enabled: true,
          },
          select: { matrixUserId: true },
        })
      : null;
    return {
      outboxId: outbox.id,
      messageId: message.id,
      text: message.text,
      operatorName: message.senderDisplayName || "Operator",
      channel,
      externalConversationId: message.channelBinding.externalConversationId,
      ...(operatorVirtualUser ? { matrixSenderUserId: operatorVirtualUser.matrixUserId } : {}),
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
  runId: string;
  errorCode: string;
  errorMessage: string;
}) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const run = await tx.generationRun.update({
      where: { id: input.runId },
      data: {
        status: GenerationRunStatus.FAILED,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        completedAt: now,
      },
    });
    await tx.message.update({
      where: { id: run.inputMessageId },
      data: {
        deliveryStatus: MessageDeliveryStatus.FAILED,
        failureCode: input.errorCode,
        failureReason: input.errorMessage,
      },
    });
    await tx.conversation.update({
      where: { id: run.conversationId },
      data: { state: "FAILED" },
    });
    await tx.outboxEvent.updateMany({
      where: { aggregateType: "generation_run", aggregateId: run.id },
      data: { status: "FAILED", lastError: input.errorMessage, availableAt: new Date(now.getTime() + 2_000) },
    });
    return run;
  });
}

export async function getPublicGenerationRunSnapshot(input: {
  representativeSlug: string;
  runId: string;
  audienceKey: string;
}) {
  const run = await prisma.generationRun.findFirst({
    where: {
      id: input.runId,
      conversation: {
        representative: { slug: input.representativeSlug },
        audienceIdentity: { audienceKey: input.audienceKey },
      },
    },
    include: {
      outputMessage: {
        select: {
          id: true,
          text: true,
          deliveryStatus: true,
          createdAt: true,
          citations: {
            select: { title: true, excerpt: true, uri: true },
          },
          attachments: {
            select: { id: true, fileName: true, mimeType: true, sizeBytes: true, externalUrl: true },
          },
        },
      },
    },
  });
  if (!run) return null;

  return {
    id: run.id,
    status: run.status.toLowerCase(),
    ...(run.errorCode ? { errorCode: run.errorCode } : {}),
    ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
    ...(run.outputMessage
      ? {
          message: {
            id: run.outputMessage.id,
            text: run.outputMessage.text || "",
            status: run.outputMessage.deliveryStatus.toLowerCase(),
            createdAt: run.outputMessage.createdAt.toISOString(),
            citations: run.outputMessage.citations.map((citation) => ({
              title: citation.title,
              ...(citation.excerpt ? { excerpt: citation.excerpt } : {}),
              ...(citation.uri ? { uri: citation.uri } : {}),
            })),
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
  audienceKey: string;
  limit?: number;
}) {
  const conversation = await prisma.conversation.findFirst({
    where: {
      representative: { slug: input.representativeSlug },
      audienceIdentity: { audienceKey: input.audienceKey },
    },
    include: {
      messages: {
        where: { redactedAt: null },
        include: {
          citations: {
            select: { title: true, excerpt: true, uri: true },
          },
          attachments: {
            select: { id: true, fileName: true, mimeType: true, sizeBytes: true, externalUrl: true },
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
    messages: conversation.messages.map((message) => ({
      id: message.id,
      role: message.senderType === MessageSenderType.AUDIENCE ? ("user" as const) : ("assistant" as const),
      senderType: normalizeSenderType(message.senderType),
      ...(message.senderDisplayName ? { senderDisplayName: message.senderDisplayName } : {}),
      text: message.text || "",
      status: message.deliveryStatus.toLowerCase(),
      createdAt: message.createdAt.toISOString(),
      citations: message.citations.map((citation) => ({
        title: citation.title,
        ...(citation.excerpt ? { excerpt: citation.excerpt } : {}),
        ...(citation.uri ? { uri: citation.uri } : {}),
      })),
      attachments: message.attachments.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(typeof attachment.sizeBytes === "number" ? { sizeBytes: attachment.sizeBytes } : {}),
        ...(attachment.externalUrl ? { url: attachment.externalUrl } : {}),
      })),
    })),
  };
}

export async function ingestMatrixApplicationServiceTransaction(input: {
  transactionId: string;
  events: MatrixApplicationServiceEvent[];
}) {
  const results: Array<{ eventId: string; status: "processed" | "duplicate" | "ignored" }> = [];

  for (const event of input.events) {
    const eventId = event.event_id?.trim();
    const eventType = event.type?.trim();
    if (!eventId || !eventType) continue;

    const existing = await prisma.channelEventInbox.findUnique({
      where: {
        kind_externalEventId: {
          kind: RepresentativeChannelKind.MATRIX,
          externalEventId: eventId,
        },
      },
      select: { id: true, status: true },
    });
    if (existing?.status === "PROCESSED") {
      results.push({ eventId, status: "duplicate" });
      continue;
    }

    const inbox = existing
      ? await prisma.channelEventInbox.update({
          where: { id: existing.id },
          data: {
            transactionId: input.transactionId,
            payload: event as Prisma.InputJsonObject,
            status: "PROCESSING",
            attemptCount: { increment: 1 },
            lastError: null,
          },
        })
      : await prisma.channelEventInbox.create({
          data: {
            kind: RepresentativeChannelKind.MATRIX,
            transactionId: input.transactionId,
            externalEventId: eventId,
            eventType,
            payload: event as Prisma.InputJsonObject,
            status: "PROCESSING",
            attemptCount: 1,
          },
        });

    try {
      const roomId = event.room_id?.trim();
      if (!roomId || !["m.room.message", "m.room.redaction"].includes(eventType)) {
        await markMatrixInboxProcessed(inbox.id);
        results.push({ eventId, status: "ignored" });
        continue;
      }

      const virtualSender = event.sender
        ? await prisma.matrixVirtualUserBinding.findUnique({
            where: { matrixUserId: event.sender },
            select: { id: true },
          })
        : null;
      if (virtualSender) {
        await markMatrixInboxProcessed(inbox.id);
        results.push({ eventId, status: "ignored" });
        continue;
      }

      const binding = await prisma.conversationChannelBinding.findFirst({
        where: {
          kind: RepresentativeChannelKind.MATRIX,
          externalConversationId: roomId,
        },
        include: {
          conversation: {
            include: { representative: { select: { slug: true } } },
          },
        },
      });
      if (!binding) {
        await markMatrixInboxProcessed(inbox.id);
        results.push({ eventId, status: "ignored" });
        continue;
      }

      await prisma.channelEventInbox.update({
        where: { id: inbox.id },
        data: { conversationId: binding.conversationId },
      });

      if (eventType === "m.room.redaction") {
        const redactedEventId = event.redacts?.trim();
        if (redactedEventId) {
          const target = await prisma.message.findFirst({
            where: { channelBindingId: binding.id, externalMessageId: redactedEventId },
            select: { id: true },
          });
          if (target) {
            await redactConversationMessage({
              representativeSlug: binding.conversation.representative.slug,
              conversationId: binding.conversationId,
              messageId: target.id,
              reason: "matrix_redaction",
            });
          }
        }
      } else {
        const content = event.content || {};
        const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
        const body = typeof content.body === "string" ? content.body.trim() : "";
        const relatesTo = isJsonRecord(content["m.relates_to"])
          ? content["m.relates_to"]
          : null;
        const relationType = relatesTo && typeof relatesTo.rel_type === "string" ? relatesTo.rel_type : null;
        const targetEventId = relatesTo && typeof relatesTo.event_id === "string" ? relatesTo.event_id : null;

        if (relationType === "m.replace" && targetEventId) {
          const replacement = isJsonRecord(content["m.new_content"])
            ? content["m.new_content"]
            : null;
          const replacementText = replacement && typeof replacement.body === "string"
            ? replacement.body.trim()
            : body.replace(/^\*\s*/, "");
          const target = await prisma.message.findFirst({
            where: { channelBindingId: binding.id, externalMessageId: targetEventId },
            select: { id: true },
          });
          if (target && replacementText) {
            await editConversationMessage({
              representativeSlug: binding.conversation.representative.slug,
              conversationId: binding.conversationId,
              messageId: target.id,
              text: replacementText,
              editedBy: event.sender || "matrix-user",
            });
          }
        } else if (msgtype === "m.text" && body) {
          await acceptInboundConversationMessage({
            representativeSlug: binding.conversation.representative.slug,
            conversationId: binding.conversationId,
            text: body,
            ...(event.sender ? { senderId: event.sender, senderDisplayName: event.sender } : {}),
            clientMessageId: eventId,
            channel: "matrix",
            externalMessageId: eventId,
          });
        }
      }

      await markMatrixInboxProcessed(inbox.id);
      results.push({ eventId, status: "processed" });
    } catch (error) {
      await prisma.channelEventInbox.update({
        where: { id: inbox.id },
        data: {
          status: "FAILED",
          lastError: error instanceof Error ? error.message : "matrix_event_processing_failed",
          availableAt: new Date(Date.now() + 2_000),
        },
      });
      throw error;
    }
  }

  return results;
}

export async function getMatrixVirtualUserBinding(matrixUserId: string) {
  return prisma.matrixVirtualUserBinding.findFirst({
    where: { matrixUserId, enabled: true },
    select: {
      matrixUserId: true,
      kind: true,
      displayName: true,
      avatarUrl: true,
      representativeId: true,
      ownerId: true,
    },
  });
}

export async function editConversationMessage(input: {
  representativeSlug: string;
  conversationId: string;
  messageId: string;
  text: string;
  editedBy: string;
}) {
  const text = input.text.trim();
  if (!text) throw new Error("Edited message text is required.");

  return prisma.$transaction(async (tx) => {
    const message = await tx.message.findFirst({
      where: {
        id: input.messageId,
        conversationId: input.conversationId,
        conversation: { representative: { slug: input.representativeSlug } },
      },
      include: {
        revisions: { orderBy: { version: "desc" }, take: 1 },
        inputForGenerationRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!message) throw new Error("Message not found.");
    if (message.redactedAt) throw new Error("Redacted messages cannot be edited.");

    const revision = await tx.messageRevision.create({
      data: {
        messageId: message.id,
        version: (message.revisions[0]?.version ?? 0) + 1,
        text,
        editedBy: input.editedBy,
      },
    });
    const run = message.inputForGenerationRuns[0];
    const action = run ? resolveMessageEditAction(generationStateMap[run.status]) : "update_only";

    await tx.message.update({
      where: { id: message.id },
      data: { text, editedAt: new Date(), deliveryStatus: MessageDeliveryStatus.EDITED },
    });

    if (run && (action === "replace_queued_run" || action === "cancel_and_requeue")) {
      await tx.generationRun.update({
        where: { id: run.id },
        data: { status: GenerationRunStatus.CANCELED, canceledAt: new Date() },
      });
      const replacement = await tx.generationRun.create({
        data: {
          conversationId: message.conversationId,
          episodeId: message.episodeId,
          inputMessageId: message.id,
          representativeVersionId: run.representativeVersionId,
          status: GenerationRunStatus.QUEUED,
          idempotencyKey: `reply:${message.conversationId}:${message.id}:revision:${revision.version}`,
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
    }

    return { revision, action };
  });
}

export async function redactConversationMessage(input: {
  representativeSlug: string;
  conversationId: string;
  messageId: string;
  reason?: string;
}) {
  const redactedAt = new Date();
  const message = await prisma.message.findFirst({
    where: {
      id: input.messageId,
      conversationId: input.conversationId,
      conversation: { representative: { slug: input.representativeSlug } },
    },
    select: { id: true },
  });
  if (!message) throw new Error("Message not found.");
  return prisma.message.update({
    where: { id: message.id },
    data: {
      deliveryStatus: MessageDeliveryStatus.REDACTED,
      redactedAt,
      redactionReason: input.reason?.trim() || null,
      retentionExpiresAt: buildRedactionPurgeAt(redactedAt),
    },
  });
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
        channelBindings: true,
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
    const conversation = await tx.conversation.findUnique({
      where: { id: input.conversationId },
      include: { contact: true, episodes: { orderBy: { sequence: "desc" }, take: 1 } },
    });
    if (!conversation) throw new Error("Conversation not found.");
    const episode = conversation.episodes[0];
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

    if (shouldRequestHandoff && episode && episode.status !== ConversationEpisodeStatus.HUMAN_ACTIVE) {
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
  });
}

export async function assignConversationOperator(input: {
  representativeSlug: string;
  conversationId: string;
  operatorId: string;
  operatorName: string;
}) {
  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { id: input.conversationId, representative: { slug: input.representativeSlug } },
      include: { episodes: { orderBy: { sequence: "desc" }, take: 1 } },
    });
    if (!conversation) throw new Error("Conversation not found.");
    const episode = conversation.episodes[0];
    if (!episode) throw new Error("Conversation has no active episode.");
    assertConversationEpisodeTransition(episodeStateMap[episode.status], "human_active");

    await tx.conversationAssignment.updateMany({
      where: { conversationId: conversation.id, status: ConversationAssignmentStatus.ACTIVE },
      data: {
        status: ConversationAssignmentStatus.TRANSFERRED,
        releasedAt: new Date(),
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
        retentionExpiresAt: buildMessageRetentionExpiry(new Date()),
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
  changeSummary?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const representative = await tx.representative.findUnique({
      where: { slug: input.representativeSlug },
      include: {
        knowledgePack: true,
        knowledgeAssetLinks: { where: { enabled: true } },
        pricingPlans: true,
        skillPackLinks: { include: { skillPack: true } },
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
    await tx.representative.update({
      where: { id: representative.id },
      data: {
        activeVersionId: version.id,
        lifecycleState: RepresentativeLifecycleState.PUBLISHED,
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
          externalUserId: `/reps/${representative.slug}`,
          status: "CONNECTED",
          displayName: representative.displayName,
          configuration: { publicMode: true, source: "publish" },
        },
        update: {
          externalUserId: `/reps/${representative.slug}`,
          status: "CONNECTED",
          displayName: representative.displayName,
          lastError: null,
        },
      });
    }
    await tx.eventAudit.create({
      data: {
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
}

export async function activateRepresentativeVersion(input: {
  representativeSlug: string;
  versionId: string;
  activatedBy: string;
}) {
  return prisma.$transaction(async (tx) => {
    const version = await tx.representativeVersion.findFirst({
      where: {
        id: input.versionId,
        representative: { slug: input.representativeSlug },
      },
      include: { representative: { select: { id: true, activeVersionId: true } } },
    });
    if (!version) throw new Error("Representative version not found.");

    await tx.representative.update({
      where: { id: version.representative.id },
      data: {
        activeVersionId: version.id,
        lifecycleState: RepresentativeLifecycleState.PUBLISHED,
      },
    });
    await tx.eventAudit.create({
      data: {
        representativeId: version.representative.id,
        type: "REPRESENTATIVE_VERSION_ACTIVATED",
        payload: {
          kind: "representative_version_activated",
          versionId: version.id,
          versionNumber: version.versionNumber,
          previousVersionId: version.representative.activeVersionId,
          activatedBy: input.activatedBy,
        },
      },
    });
    return version;
  });
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
  knowledgePack: { identitySummary: string; faq: Prisma.JsonValue; materials: Prisma.JsonValue; policies: Prisma.JsonValue } | null;
  pricingPlans: Array<{ type: string; name: string; starsAmount: number; summary: string; includedReplies: number; includesPriorityHandoff: boolean }>;
  skillPackLinks: Array<{ enabled: boolean; skillPack: { slug: string; version: string | null } }>;
  channelBindings: Array<{ kind: string; status: string; externalUserId: string | null }>;
}): Prisma.InputJsonObject {
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
    knowledge: representative.knowledgePack
      ? {
          identitySummary: representative.knowledgePack.identitySummary,
          faq: representative.knowledgePack.faq,
          materials: representative.knowledgePack.materials,
          policies: representative.knowledgePack.policies,
        }
      : null,
    pricing: representative.pricingPlans.map((plan) => ({
      tier: plan.type.toLowerCase(),
      name: plan.name,
      stars: plan.starsAmount,
      summary: plan.summary,
      includedReplies: plan.includedReplies,
      includesPriorityHandoff: plan.includesPriorityHandoff,
    })),
    skills: representative.skillPackLinks.map((link) => ({
      slug: link.skillPack.slug,
      version: link.skillPack.version,
      enabled: link.enabled,
    })),
    channels: representative.channelBindings.map((binding) => ({
      kind: binding.kind,
      status: binding.status,
      externalUserId: binding.externalUserId,
    })),
  };
}

function normalizeChannel(value: string | null): "web" | "matrix" | "telegram" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "matrix") return "matrix";
  if (normalized === "telegram") return "telegram";
  return "web";
}

function mapChannelKind(value: AcceptInboundMessageInput["channel"]): RepresentativeChannelKind {
  if (value === "matrix") return RepresentativeChannelKind.MATRIX;
  if (value === "telegram") return RepresentativeChannelKind.TELEGRAM;
  return RepresentativeChannelKind.WEB;
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

async function markMatrixInboxProcessed(id: string) {
  await prisma.channelEventInbox.update({
    where: { id },
    data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
  });
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildDemoInboxSnapshot(representativeSlug: string): ConversationInboxSnapshot {
  return {
    representative: {
      id: "demo-representative",
      slug: representativeSlug,
      displayName: "Delegate Product Representative",
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

function buildRepresentativeReadiness(input: {
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
      detail: "Free, pass, deep help, and sponsor tiers are configured.",
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
