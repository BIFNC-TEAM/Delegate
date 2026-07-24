import type { PlanTier } from "@delegate/domain";
import type { ModelContextSegmentTrace } from "@delegate/lifecycle-hooks";
import {
  assertConversationChannelDeliveryAvailable,
  createServicePaymentOrder,
  fulfillServicePaymentOrder,
  resolveChannelAudienceIdentity,
} from "@delegate/web-data";
import {
  handoffFollowUpDedupeKey,
  getWorkflowEngineConfig,
  resolveWorkflowDispatchTarget,
  scheduleHandoffFollowUp,
  shouldDispatchWorkflowViaTemporalOutbox,
} from "@delegate/workflows";
import type {
  ConversationPlan,
  ConversationUsage,
  StructuredCollectorState,
} from "@delegate/runtime";
import {
  buildStructuredCollectorHandoffSummary,
  buildStructuredCollectorOwnerAction,
  calculateStructuredCollectorPriority,
  formatStructuredCollectorSummary,
  readStructuredCollectorState,
} from "@delegate/runtime";
import {
  AudienceRole,
  Channel,
  ChannelDesiredState,
  ChannelHealthStatus,
  ChannelSourceProvider,
  ChannelTransport,
  ComputeFilesystemMode,
  ComputeNetworkMode,
  ContactStage,
  EventType,
  HandoffStatus,
  InvoiceStatus,
  PaymentProvider,
  Prisma,
  PricingPlanType,
  RepresentativeChannelKind,
} from "@prisma/client";

import { prisma } from "./prisma";
import { assertTelegramStarsLivePaymentEnabled } from "./conversation-platform-mode";

export type TelegramActor = {
  telegramUserId: number;
  username?: string;
  displayName?: string;
  chatId: number | string;
  channel: Channel;
};

export type ConversationContextRecord = {
  representativeId: string;
  representativeSlug: string;
  audienceIdentityId: string;
  contactId: string;
  conversationId: string;
  contactIsPaid: boolean;
  usage: ConversationUsage;
  collectorState: StructuredCollectorState | null;
  plans: {
    free?: StoredPlan;
    pass?: StoredPlan;
    deep_help?: StoredPlan;
    sponsor?: StoredPlan;
  };
  openviking: {
    enabled: boolean;
    agentId?: string;
    autoRecall: boolean;
    autoCapture: boolean;
    captureMode: string;
    recallLimit: number;
    recallScoreThreshold: number;
    targetUri?: string;
    sessionId?: string;
    sessionKey?: string;
  };
  compute: {
    enabled: boolean;
    defaultPolicyMode: "allow" | "ask" | "deny";
    baseImage: string;
    maxSessionMinutes: number;
    autoApproveBudgetCents: number;
    artifactRetentionDays: number;
    networkMode: "no_network" | "allowlist" | "full";
    networkAllowlist: string[];
    filesystemMode: "workspace_only" | "read_only_workspace" | "ephemeral_full";
    conversationBudgetRemainingCredits?: number;
  };
};

type ConversationAuditScope = Pick<
  ConversationContextRecord,
  "representativeId" | "representativeSlug" | "contactId" | "conversationId"
>;

type TransactionClient = Prisma.TransactionClient;

const workflowEngineConfig = getWorkflowEngineConfig(process.env);

type StoredPlan = {
  id: string;
  tier: PlanTier;
  name: string;
  starsAmount: number;
  includedReplies: number;
  includesPriorityHandoff: boolean;
};

type SuccessfulPaymentInput = {
  invoicePayload: string;
  totalAmount: number;
  currency: string;
  telegramUserId: number;
  telegramPaymentChargeId: string;
  providerPaymentChargeId?: string;
};

export type TelegramPaymentConfirmation = {
  planName: string;
  starsAmount: number;
  representativeSlug: string;
  representativeId: string;
  contactId: string;
  conversationId?: string;
  planType: PlanTier;
};

export type TelegramPaymentProcessingResult =
  | {
      status: "confirmed";
      confirmation: TelegramPaymentConfirmation;
    }
  | {
      status: "retrying";
    };

const telegramPaymentProcessingLeaseMs = 30_000;
const telegramPaymentMaximumBackoffMs = 15 * 60_000;

export async function getConversationContext(
  representativeSlug: string,
  actor: TelegramActor,
): Promise<ConversationContextRecord> {
  const representative = await prisma.representative.findUnique({
    where: { slug: representativeSlug },
    include: {
      pricingPlans: true,
    },
  });

  if (!representative) {
    throw new Error(`Representative "${representativeSlug}" not found. Run db:seed first.`);
  }

  const now = new Date();
  const telegramUserId = String(actor.telegramUserId);
  const channelUserId = `telegram:${telegramUserId}`;
  const connectionId = telegramBotConnectionId();
  const audienceIdentity = await resolveChannelAudienceIdentity({
    provider: "TELEGRAM",
    providerSubject: telegramUserId,
    issuer: "delegate-managed-bot",
    connectionId,
    now,
  });

  const contact = await prisma.contact.upsert({
    where: {
      representativeId_telegramUserId: {
        representativeId: representative.id,
        telegramUserId,
      },
    },
    create: {
      representativeId: representative.id,
      audienceIdentityId: audienceIdentity.id,
      telegramUserId,
      channelUserId,
      externalUserId: channelUserId,
      username: actor.username ?? null,
      displayName: actor.displayName ?? actor.username ?? String(actor.telegramUserId),
      role: AudienceRole.OTHER,
      stage: ContactStage.NEW,
      isPaid: false,
      source: actor.channel.toLowerCase(),
      sourceChannel: "telegram",
      lastSeenAt: now,
    },
    update: {
      audienceIdentityId: audienceIdentity.id,
      channelUserId,
      externalUserId: channelUserId,
      username: actor.username ?? null,
      displayName: actor.displayName ?? actor.username ?? String(actor.telegramUserId),
      source: actor.channel.toLowerCase(),
      sourceChannel: "telegram",
      lastSeenAt: now,
    },
  });

  const conversation = await prisma.conversation.upsert({
    where: {
      representativeId_telegramChatId_contactId: {
        representativeId: representative.id,
        telegramChatId: String(actor.chatId),
        contactId: contact.id,
      },
    },
    create: {
      representativeId: representative.id,
      contactId: contact.id,
      audienceIdentityId: audienceIdentity.id,
      telegramChatId: String(actor.chatId),
      channel: actor.channel,
      sourceChannel: "telegram",
      externalConversationId: String(actor.chatId),
      state: "ACTIVE",
      freeRepliesUsed: 0,
      lastMessageAt: now,
    },
    update: {
      audienceIdentityId: audienceIdentity.id,
      channel: actor.channel,
      sourceChannel: "telegram",
      externalConversationId: String(actor.chatId),
      lastMessageAt: now,
    },
  });

  const representativeBinding = await prisma.representativeChannelBinding.upsert({
    where: {
      representativeId_kind: {
        representativeId: representative.id,
        kind: "TELEGRAM",
      },
    },
    create: {
      representativeId: representative.id,
      kind: "TELEGRAM",
      transport: ChannelTransport.TELEGRAM,
      sourceProvider: ChannelSourceProvider.TELEGRAM,
      connectionId,
      desiredState: ChannelDesiredState.ACTIVE,
      healthStatus: ChannelHealthStatus.HEALTHY,
      externalUserId: process.env.TELEGRAM_BOT_USERNAME
        ? `@${process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, "")}`
        : `telegram:${representative.slug}`,
      status: "CONNECTED",
      displayName: representative.displayName,
      configuration: { managed: true, source: "telegram_bot" },
      lastHealthCheckAt: now,
    },
    update: {
      transport: ChannelTransport.TELEGRAM,
      sourceProvider: ChannelSourceProvider.TELEGRAM,
      connectionId,
      healthStatus: ChannelHealthStatus.HEALTHY,
      status: "CONNECTED",
      lastHealthCheckAt: now,
      lastError: null,
    },
  });
  const bindingKey = `TELEGRAM:${representative.id}:${String(actor.chatId)}:`;
  await prisma.conversationChannelBinding.upsert({
    where: { bindingKey },
    create: {
      conversationId: conversation.id,
      representativeBindingId: representativeBinding.id,
      kind: "TELEGRAM",
      transport: ChannelTransport.TELEGRAM,
      sourceProvider: ChannelSourceProvider.TELEGRAM,
      connectionId: representativeBinding.connectionId,
      bindingKey,
      externalConversationId: String(actor.chatId),
      metadata: {
        source: "telegram_bot",
        telegramUserId,
      },
    },
    update: {
      conversationId: conversation.id,
      representativeBindingId: representativeBinding.id,
      transport: ChannelTransport.TELEGRAM,
      sourceProvider: ChannelSourceProvider.TELEGRAM,
      connectionId: representativeBinding.connectionId,
    },
  });

  return {
    representativeId: representative.id,
    representativeSlug: representative.slug,
    audienceIdentityId: audienceIdentity.id,
    contactId: contact.id,
    conversationId: conversation.id,
    contactIsPaid: contact.isPaid,
    usage: {
      freeRepliesUsed: conversation.freeRepliesUsed,
      passUnlocked: Boolean(conversation.passUnlockedAt),
      deepHelpUnlocked: Boolean(conversation.deepHelpUnlockedAt),
    },
    collectorState: readStructuredCollectorState(conversation.collectorState),
    plans: representative.pricingPlans.reduce<ConversationContextRecord["plans"]>((acc, plan) => {
      acc[mapPricingPlanTypeFromDb(plan.type)] = {
        id: plan.id,
        tier: mapPricingPlanTypeFromDb(plan.type),
        name: plan.name,
        starsAmount: plan.starsAmount,
        includedReplies: plan.includedReplies,
        includesPriorityHandoff: plan.includesPriorityHandoff,
      };
      return acc;
    }, {}),
    openviking: {
      enabled: representative.openvikingEnabled,
      ...(representative.openvikingAgentId ? { agentId: representative.openvikingAgentId } : {}),
      autoRecall: representative.openvikingAutoRecall,
      autoCapture: representative.openvikingAutoCapture,
      captureMode: representative.openvikingCaptureMode,
      recallLimit: representative.openvikingRecallLimit,
      recallScoreThreshold: representative.openvikingRecallScoreThreshold,
      ...(representative.openvikingTargetUri
        ? { targetUri: representative.openvikingTargetUri }
        : {}),
      ...(conversation.openvikingSessionId ? { sessionId: conversation.openvikingSessionId } : {}),
      ...(conversation.openvikingSessionKey ? { sessionKey: conversation.openvikingSessionKey } : {}),
    },
    compute: {
      enabled: representative.computeEnabled,
      defaultPolicyMode: representative.computeDefaultPolicyMode.toLowerCase() as
        | "allow"
        | "ask"
        | "deny",
      baseImage: representative.computeBaseImage,
      maxSessionMinutes: representative.computeMaxSessionMinutes,
      autoApproveBudgetCents: representative.computeAutoApproveBudgetCents,
      artifactRetentionDays: representative.computeArtifactRetentionDays,
      networkMode: mapComputeNetworkModeFromDb(representative.computeNetworkMode),
      networkAllowlist: representative.computeNetworkAllowlist,
      filesystemMode: mapComputeFilesystemModeFromDb(representative.computeFilesystemMode),
      ...(typeof conversation.computeBudgetRemainingCredits === "number"
        ? {
            conversationBudgetRemainingCredits: conversation.computeBudgetRemainingCredits,
          }
        : {}),
    },
  };
}

export async function getActiveRepresentativeSlugForChat(
  telegramChatId: number | string,
): Promise<string | null> {
  const session = await prisma.chatSession.findUnique({
    where: {
      telegramChatId: String(telegramChatId),
    },
    include: {
      representative: {
        select: {
          slug: true,
        },
      },
    },
  });

  return session?.representative.slug ?? null;
}

export async function setActiveRepresentativeForChat(params: {
  telegramChatId: number | string;
  telegramUserId: number;
  representativeSlug: string;
}): Promise<string> {
  const representative = await prisma.representative.findUnique({
    where: { slug: params.representativeSlug },
    select: { id: true, slug: true },
  });

  if (!representative) {
    throw new Error(`Representative "${params.representativeSlug}" not found.`);
  }

  await prisma.chatSession.upsert({
    where: {
      telegramChatId: String(params.telegramChatId),
    },
    create: {
      telegramChatId: String(params.telegramChatId),
      telegramUserId: String(params.telegramUserId),
      representativeId: representative.id,
    },
    update: {
      telegramUserId: String(params.telegramUserId),
      representativeId: representative.id,
    },
  });

  return representative.slug;
}

export async function setStructuredCollectorState(params: {
  context: ConversationContextRecord;
  collectorState: StructuredCollectorState;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.conversation.update({
      where: { id: params.context.conversationId },
      data: {
        collectorState: params.collectorState,
        state: "COLLECTING",
      },
    });

    await tx.eventAudit.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        type: EventType.INTAKE_STARTED,
        payload: {
          collectorKind: params.collectorState.kind,
          intent: params.collectorState.intent,
          stepIndex: params.collectorState.stepIndex,
        },
      },
    });
  });
}

export async function updateStructuredCollectorState(params: {
  context: ConversationContextRecord;
  collectorState: StructuredCollectorState;
}): Promise<void> {
  await prisma.conversation.update({
    where: { id: params.context.conversationId },
    data: {
      collectorState: params.collectorState,
      state: "COLLECTING",
    },
  });
}

export async function recordInboundTurn(params: {
  context: ConversationContextRecord;
  plan: ConversationPlan;
  text: string;
  subagentId?: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.conversationTurn.create({
      data: {
        conversationId: params.context.conversationId,
        direction: "inbound",
        messageText: params.text,
        intent: params.plan.intent,
        summary: params.plan.reasons.join(" "),
      },
    });

    await tx.eventAudit.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        type: EventType.MESSAGE_RECEIVED,
        payload: {
          intent: params.plan.intent,
          nextStep: params.plan.nextStep,
          subagentId: params.subagentId ?? null,
        },
      },
    });
  });
}

export async function recordComputeInboundTurn(params: {
  context: ConversationContextRecord;
  text: string;
  capability: string;
  subagentId?: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.conversationTurn.create({
      data: {
        conversationId: params.context.conversationId,
        direction: "inbound",
        messageText: params.text,
        intent: "compute",
        summary: `Compute request (${params.capability}).`,
      },
    });

    await tx.eventAudit.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        type: EventType.MESSAGE_RECEIVED,
        payload: {
          intent: "compute",
          capability: params.capability,
          subagentId: params.subagentId ?? null,
        },
      },
    });
  });
}

export async function recordOutboundReply(params: {
  context: ConversationContextRecord;
  plan: ConversationPlan;
  messageText: string;
  subagentId?: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.conversationTurn.create({
      data: {
        conversationId: params.context.conversationId,
        direction: "outbound",
        messageText: params.messageText,
        intent: params.plan.intent,
        summary: params.plan.responseOutline.join(" "),
      },
    });

    await tx.eventAudit.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        type: EventType.MESSAGE_ANSWERED,
        payload: {
          intent: params.plan.intent,
          nextStep: params.plan.nextStep,
          suggestedPlan: params.plan.suggestedPlan ?? null,
          subagentId: params.subagentId ?? null,
        },
      },
    });

    if (
      !params.context.usage.passUnlocked &&
      !params.context.usage.deepHelpUnlocked &&
      params.plan.nextStep !== "offer_paid_unlock"
    ) {
      await tx.conversation.update({
        where: { id: params.context.conversationId },
        data: {
          freeRepliesUsed: {
            increment: 1,
          },
        },
      });
    }
  });
}

export async function getRecentConversationTurns(params: {
  conversationId: string;
  limit?: number;
}): Promise<
  Array<{
    direction: "inbound" | "outbound";
    messageText: string;
    intent?: string | null;
    summary?: string | null;
  }>
> {
  const turns = await prisma.conversationTurn.findMany({
    where: {
      conversationId: params.conversationId,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: params.limit ?? 6,
    select: {
      direction: true,
      messageText: true,
      intent: true,
      summary: true,
    },
  });

  return turns
    .reverse()
    .map((turn) => ({
      direction: turn.direction === "inbound" ? "inbound" : "outbound",
      messageText: turn.messageText,
      ...(turn.intent ? { intent: turn.intent } : {}),
      ...(turn.summary ? { summary: turn.summary } : {}),
    }));
}

export async function recordModelUsage(params: {
  context: ConversationContextRecord;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  responseId?: string;
  costCents?: number;
  estimatedCostUsd?: number;
}): Promise<void> {
  const quantity =
    typeof params.totalTokens === "number"
      ? params.totalTokens
      : (params.inputTokens ?? 0) + (params.outputTokens ?? 0);
  const costCents = typeof params.costCents === "number" ? params.costCents : 0;

  await prisma.$transaction(async (tx) => {
    await tx.ledgerEntry.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        kind: "MODEL_USAGE",
        quantity,
        unit: "token",
        costCents,
        creditDelta: 0,
        notes: JSON.stringify({
          provider: params.provider,
          model: params.model,
          inputTokens: params.inputTokens ?? 0,
          outputTokens: params.outputTokens ?? 0,
          totalTokens: quantity,
          responseId: params.responseId ?? null,
          costCents,
          estimatedCostUsd: params.estimatedCostUsd ?? null,
        }),
      },
    });

    await tx.eventAudit.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        type: EventType.BILLING_LEDGER_RECORDED,
        payload: {
          kind: "MODEL_USAGE",
          provider: params.provider,
          model: params.model,
          inputTokens: params.inputTokens ?? null,
          outputTokens: params.outputTokens ?? null,
          totalTokens: quantity,
          responseId: params.responseId ?? null,
          costCents,
          estimatedCostUsd: params.estimatedCostUsd ?? null,
        },
      },
    });
  });
}

export async function recordModelContextAssembly(params: {
  context: ConversationAuditScope;
  subagentId?: string;
  provider: string;
  model: string;
  estimatedInputTokens: number;
  segments: ModelContextSegmentTrace[];
  selectedKnowledgeTitles: string[];
  selectedRecallUris: string[];
}): Promise<void> {
  await prisma.eventAudit.create({
    data: {
      representativeId: params.context.representativeId,
      contactId: params.context.contactId,
      conversationId: params.context.conversationId,
      type: EventType.MODEL_CONTEXT_ASSEMBLED,
      payload: {
        provider: params.provider,
        model: params.model,
        subagentId: params.subagentId ?? null,
        estimatedInputTokens: params.estimatedInputTokens,
        segments: params.segments,
        selectedKnowledgeTitles: params.selectedKnowledgeTitles,
        selectedRecallUris: params.selectedRecallUris,
      },
    },
  });
}

export async function recordModelReplyCompleted(params: {
  context: ConversationAuditScope;
  subagentId?: string;
  provider: string;
  model: string;
  success: boolean;
  reason?: string;
  responseId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedInputTokens?: number;
}): Promise<void> {
  await prisma.eventAudit.create({
    data: {
      representativeId: params.context.representativeId,
      contactId: params.context.contactId,
      conversationId: params.context.conversationId,
      type: EventType.MODEL_REPLY_COMPLETED,
      payload: {
        provider: params.provider,
        model: params.model,
        subagentId: params.subagentId ?? null,
        success: params.success,
        reason: params.reason ?? null,
        responseId: params.responseId ?? null,
        inputTokens: params.inputTokens ?? null,
        outputTokens: params.outputTokens ?? null,
        totalTokens: params.totalTokens ?? null,
        estimatedInputTokens: params.estimatedInputTokens ?? null,
      },
    },
  });
}

export async function recordComputeReply(params: {
  context: ConversationContextRecord;
  messageText: string;
  capability: string;
  outcome: string;
  subagentId?: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.conversationTurn.create({
      data: {
        conversationId: params.context.conversationId,
        direction: "outbound",
        messageText: params.messageText,
        intent: "compute",
        summary: `Compute ${params.outcome} (${params.capability}).`,
      },
    });

    await tx.eventAudit.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        type: EventType.MESSAGE_ANSWERED,
        payload: {
          intent: "compute",
          capability: params.capability,
          outcome: params.outcome,
          subagentId: params.subagentId ?? null,
        },
      },
    });
  });
}

export async function maybeCreateHandoffRequest(params: {
  context: ConversationContextRecord;
  plan: ConversationPlan;
  text: string;
  prepared?: {
    priority: number;
    summary: string;
    ownerAction: string;
  };
}): Promise<{
  id: string;
  status: HandoffStatus;
} | null> {
  if (params.plan.nextStep !== "handoff" && params.plan.nextStep !== "ask_owner") {
    return null;
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.handoffRequest.findFirst({
      where: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        reason: params.plan.intent,
        status: {
          in: [HandoffStatus.OPEN, HandoffStatus.REVIEWING],
        },
      },
      orderBy: [{ createdAt: "desc" }],
    });

    if (existing) {
      return {
        id: existing.id,
        status: existing.status,
      };
    }

    const intake = await tx.intakeSubmission.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        requestType: params.plan.intent,
        payload: {
          text: params.text,
          audienceRole: params.plan.audienceRole,
          suggestedPlan: params.plan.suggestedPlan ?? null,
          reasons: params.plan.reasons,
        },
        priorityScore: params.prepared?.priority ?? calculatePriority(params.plan),
        recommendedNextStep: params.plan.nextStep === "ask_owner" ? "owner_approval" : "owner_review",
      },
    });

    const handoff = await tx.handoffRequest.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        intakeSubmissionId: intake.id,
        reason: params.plan.intent,
        summary: params.prepared?.summary ?? summarizeText(params.text),
        recommendedPriority: params.prepared?.priority ?? calculatePriority(params.plan),
        recommendedOwnerAction: params.prepared?.ownerAction ?? buildOwnerAction(params.plan),
        status: HandoffStatus.OPEN,
      },
    });

    await tx.contact.update({
      where: { id: params.context.contactId },
      data: {
        stage: ContactStage.WAITING_ON_OWNER,
      },
    });

    await tx.eventAudit.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        type: EventType.HANDOFF_REQUESTED,
        payload: {
          handoffId: handoff.id,
          priority: handoff.recommendedPriority,
          intent: params.plan.intent,
        },
      },
    });

    await enqueueHandoffFollowUpWorkflowTx(tx, {
      representativeId: params.context.representativeId,
      representativeSlug: params.context.representativeSlug,
      contactId: params.context.contactId,
      conversationId: params.context.conversationId,
      handoffId: handoff.id,
    });

    return {
      id: handoff.id,
      status: handoff.status,
    };
  });
}

export function buildHandoffPreparation(params: {
  plan: ConversationPlan;
  text: string;
}): {
  priority: number;
  summary: string;
  ownerAction: string;
} {
  return {
    priority: calculatePriority(params.plan),
    summary: summarizeText(params.text),
    ownerAction: buildOwnerAction(params.plan),
  };
}

export async function recordHandoffPrepared(params: {
  context: ConversationAuditScope;
  subagentId?: string;
  intent: string;
  nextStep: string;
  summary: string;
  ownerAction: string;
  priority: number;
}): Promise<void> {
  await prisma.eventAudit.create({
    data: {
      representativeId: params.context.representativeId,
      contactId: params.context.contactId,
      conversationId: params.context.conversationId,
      type: EventType.HANDOFF_PREPARED,
      payload: {
        subagentId: params.subagentId ?? null,
        intent: params.intent,
        nextStep: params.nextStep,
        summary: params.summary,
        ownerAction: params.ownerAction,
        priority: params.priority,
      },
    },
  });
}

export async function clearStructuredCollectorState(context: ConversationContextRecord): Promise<void> {
  await prisma.conversation.update({
    where: { id: context.conversationId },
    data: {
      collectorState: Prisma.JsonNull,
      state: "ACTIVE",
    },
  });
}

export async function setConversationOpenVikingSession(params: {
  conversationId: string;
  sessionId: string;
  sessionKey: string;
}): Promise<void> {
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      openvikingSessionId: params.sessionId,
      openvikingSessionKey: params.sessionKey,
    },
  });
}

export async function setActiveComputeSession(params: {
  conversationId: string;
  sessionId: string;
}): Promise<void> {
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      activeComputeSessionId: params.sessionId,
      lastComputeAt: new Date(),
    },
  });
}

export async function recordOpenVikingRecallTrace(params: {
  representativeId: string;
  contactId: string;
  conversationId: string;
  queryText: string;
  recalledUri: string;
  contextType: string;
  layer: string;
  score: number;
}): Promise<void> {
  await prisma.conversationRecallTrace.create({
    data: {
      representativeId: params.representativeId,
      contactId: params.contactId,
      conversationId: params.conversationId,
      queryText: params.queryText,
      recalledUri: params.recalledUri,
      contextType: params.contextType,
      layer: params.layer,
      score: params.score,
    },
  });
}

export async function recordOpenVikingCommitTrace(params: {
  representativeId: string;
  contactId: string;
  conversationId: string;
  sessionId: string;
  sessionKey?: string;
  reason: string;
  status: "succeeded" | "failed";
  memoriesExtracted?: number;
  archived?: boolean;
  error?: string;
}): Promise<void> {
  await prisma.conversationCommitTrace.create({
    data: {
      representativeId: params.representativeId,
      contactId: params.contactId,
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey ?? null,
      reason: params.reason,
      status: params.status,
      memoriesExtracted: params.memoriesExtracted ?? null,
      archived: params.archived ?? null,
      error: params.error ?? null,
    },
  });
}

export async function upsertOpenVikingMemoryRecord(params: {
  representativeId: string;
  representativeSlug: string;
  contactId?: string;
  uri: string;
  contextType: string;
  scope: string;
  category: string;
  summary: string;
  sourceKind: string;
}): Promise<void> {
  await prisma.openVikingMemoryRecord.upsert({
    where: { uri: params.uri },
    create: {
      representativeId: params.representativeId,
      contactId: params.contactId ?? null,
      uri: params.uri,
      contextType: params.contextType,
      scope: params.scope,
      category: params.category,
      summary: params.summary,
      sourceKind: params.sourceKind,
    },
    update: {
      contactId: params.contactId ?? null,
      contextType: params.contextType,
      scope: params.scope,
      category: params.category,
      summary: params.summary,
      sourceKind: params.sourceKind,
    },
  });
}

export async function submitStructuredCollector(params: {
  context: ConversationContextRecord;
  collectorState: StructuredCollectorState;
}): Promise<{
  handoffId: string;
  summary: string;
  recommendedOwnerAction: string;
  priority: number;
}> {
  const summary = buildStructuredCollectorHandoffSummary(params.collectorState);
  const recommendedOwnerAction = buildStructuredCollectorOwnerAction(params.collectorState);
  const priority = calculateStructuredCollectorPriority(
    params.collectorState,
    params.context.contactIsPaid,
  );

  return prisma.$transaction(async (tx) => {
    const intake = await tx.intakeSubmission.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        requestType: params.collectorState.intent,
        payload: {
          collectorKind: params.collectorState.kind,
          sourceChannel: params.collectorState.sourceChannel,
          suggestedPlan: params.collectorState.suggestedPlan ?? null,
          startedAt: params.collectorState.startedAt,
          completedAt: new Date().toISOString(),
          answers: params.collectorState.answers,
          summary: formatStructuredCollectorSummary(params.collectorState),
        },
        priorityScore: priority,
        recommendedNextStep:
          params.collectorState.kind === "scheduling"
            ? "owner_schedule_review"
            : "owner_quote_review",
      },
    });

    const existing = await tx.handoffRequest.findFirst({
      where: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        reason: params.collectorState.intent,
        status: {
          in: [HandoffStatus.OPEN, HandoffStatus.REVIEWING],
        },
      },
      orderBy: [{ createdAt: "desc" }],
    });

    const handoff = existing
      ? await tx.handoffRequest.update({
          where: { id: existing.id },
          data: {
            intakeSubmissionId: intake.id,
            summary: summary || existing.summary,
            recommendedPriority: priority,
            recommendedOwnerAction,
          },
        })
      : await tx.handoffRequest.create({
          data: {
            representativeId: params.context.representativeId,
            contactId: params.context.contactId,
            conversationId: params.context.conversationId,
            intakeSubmissionId: intake.id,
            reason: params.collectorState.intent,
            summary: summary || "Structured intake completed.",
            recommendedPriority: priority,
            recommendedOwnerAction,
            status: HandoffStatus.OPEN,
          },
        });

    await tx.contact.update({
      where: { id: params.context.contactId },
      data: {
        stage: ContactStage.WAITING_ON_OWNER,
      },
    });

    await tx.conversation.update({
      where: { id: params.context.conversationId },
      data: {
        collectorState: Prisma.JsonNull,
        state: "ACTIVE",
      },
    });

    await tx.eventAudit.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        type: EventType.INTAKE_SUBMITTED,
        payload: {
          intakeSubmissionId: intake.id,
          handoffId: handoff.id,
          collectorKind: params.collectorState.kind,
          summary,
          priority,
        },
      },
    });

    if (!existing) {
      await tx.eventAudit.create({
        data: {
          representativeId: params.context.representativeId,
          contactId: params.context.contactId,
          conversationId: params.context.conversationId,
          type: EventType.HANDOFF_REQUESTED,
          payload: {
            handoffId: handoff.id,
            priority,
            intent: params.collectorState.intent,
          },
        },
      });
    }

    await enqueueHandoffFollowUpWorkflowTx(tx, {
      representativeId: params.context.representativeId,
      representativeSlug: params.context.representativeSlug,
      contactId: params.context.contactId,
      conversationId: params.context.conversationId,
      handoffId: handoff.id,
    });

    return {
      handoffId: handoff.id,
      summary: summary || "Structured intake completed.",
      recommendedOwnerAction,
      priority,
    };
  });
}

export async function createPlanInvoice(params: {
  context: ConversationContextRecord;
  tier: PlanTier;
  providerAccountId: string;
}): Promise<{
  invoiceId: string;
  payload: string;
  title: string;
  starsAmount: number;
}> {
  assertTelegramStarsLivePaymentEnabled();
  const plan = params.context.plans[params.tier];
  if (!plan) {
    throw new Error(`Plan "${params.tier}" is not configured for this representative.`);
  }

  const invoiceId = `${params.context.conversationId}_${plan.tier}_${Date.now()}`;
  const payload = buildInvoicePayload(invoiceId);

  const invoice = await prisma.$transaction(async (tx) => {
    const createdInvoice = await tx.invoice.create({
      data: {
        id: invoiceId,
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        planType: mapPricingPlanTypeToDb(plan.tier),
        title: plan.name,
        payload,
        starsAmount: plan.starsAmount,
        status: InvoiceStatus.PENDING,
      },
    });

    if (plan.tier !== "sponsor") {
      await createServicePaymentOrder(
        {
          id: `service-payment:${createdInvoice.id}`,
          payerAudienceIdentityId: params.context.audienceIdentityId,
          representativeId: params.context.representativeId,
          provider: PaymentProvider.TELEGRAM_STARS,
          providerAccountId: params.providerAccountId,
          providerOrderId: createdInvoice.payload,
          productCode: `plan:${plan.tier}`,
          amountMinor: plan.starsAmount,
          currency: "XTR",
          entitlementUnits: Math.max(1, plan.includedReplies),
          priceSnapshot: {
            source: "telegram_stars",
            planId: plan.id,
            planType: plan.tier,
            title: plan.name,
            includedReplies: plan.includedReplies,
          },
        },
        tx as never,
      );
    }

    await tx.eventAudit.create({
      data: {
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        type: EventType.PAYMENT_INVOICE_CREATED,
        payload: {
          invoiceId: createdInvoice.id,
          planType: plan.tier,
          starsAmount: plan.starsAmount,
        },
      },
    });
    return createdInvoice;
  });

  return {
    invoiceId: invoice.id,
    payload: invoice.payload,
    title: invoice.title,
    starsAmount: invoice.starsAmount,
  };
}

async function enqueueHandoffFollowUpWorkflowTx(
  tx: TransactionClient,
  params: {
    representativeId: string;
    representativeSlug: string;
    contactId: string;
    conversationId: string;
    handoffId: string;
  },
) {
  const dedupeKey = handoffFollowUpDedupeKey(params.handoffId);
  const existing = await tx.workflowRun.findUnique({
    where: {
      dedupeKey,
    },
    select: {
      id: true,
    },
  });

  if (existing) {
    return existing.id;
  }

  const representative = await tx.representative.findUnique({
    where: {
      id: params.representativeId,
    },
    select: {
      handoffWindowHours: true,
    },
  });

  const handoffWindowHours = representative?.handoffWindowHours ?? 24;
  const scheduledAt = scheduleHandoffFollowUp(new Date(), handoffWindowHours);
  const dispatchTarget = resolveWorkflowDispatchTarget({
    config: workflowEngineConfig,
    kind: "handoff_follow_up",
    representativeKey: params.representativeSlug,
    subjectId: params.handoffId,
  });
  const isTemporal = shouldDispatchWorkflowViaTemporalOutbox(dispatchTarget);
  const workflow = await tx.workflowRun.create({
    data: {
      representativeId: params.representativeId,
      contactId: params.contactId,
      conversationId: params.conversationId,
      handoffRequestId: params.handoffId,
      kind: "HANDOFF_FOLLOW_UP",
      engine: isTemporal ? "TEMPORAL" : "LOCAL_RUNNER",
      status: "QUEUED",
      ...(isTemporal
        ? {
            enginePhase: "DISPATCH_PENDING",
            nextWakeAt: scheduledAt,
          }
        : {}),
      dedupeKey,
      queueName: dispatchTarget.queueName,
      externalWorkflowId: dispatchTarget.externalWorkflowId,
      scheduledAt,
      input: {
        handoffId: params.handoffId,
        handoffWindowHours,
      },
      ...(isTemporal
        ? {
            commandOutbox: {
              create: {
                commandType: "START",
                payload: {
                  source: "handoff_follow_up_enqueue",
                  scheduledAt: scheduledAt.toISOString(),
                },
              },
            },
          }
        : {}),
    },
  });

  await tx.eventAudit.create({
    data: {
      representativeId: params.representativeId,
      contactId: params.contactId,
      conversationId: params.conversationId,
      type: EventType.WORKFLOW_ENQUEUED,
      payload: {
        workflowRunId: workflow.id,
        workflowKind: "handoff_follow_up",
        representativeSlug: params.representativeSlug,
        handoffId: params.handoffId,
        configuredEngine: dispatchTarget.configuredEngine,
        effectiveEngine: dispatchTarget.effectiveEngine,
        queueName: dispatchTarget.queueName,
        externalWorkflowId: dispatchTarget.externalWorkflowId,
        temporalReady: dispatchTarget.temporalReady,
        fallbackReason: dispatchTarget.fallbackReason,
        scheduledAt: scheduledAt.toISOString(),
      },
    },
  });

  return workflow.id;
}

export async function markInvoiceDeliveryUncertain(
  invoiceId: string,
  errorMessage?: string,
): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      representativeId: true,
      contactId: true,
      conversationId: true,
      status: true,
    },
  });

  if (!invoice || invoice.status !== InvoiceStatus.PENDING) {
    return;
  }

  await prisma.eventAudit.create({
    data: {
      representativeId: invoice.representativeId,
      contactId: invoice.contactId,
      conversationId: invoice.conversationId,
      type: EventType.PAYMENT_INVOICE_CREATED,
      payload: {
        invoiceId: invoice.id,
        deliveryStatus: "UNCERTAIN",
        ...(errorMessage ? { errorMessage: errorMessage.slice(0, 500) } : {}),
      },
    },
  });
}

export async function validatePendingInvoice(
  payload: string,
  telegramUserId: number,
  payment: { currency: string; totalAmount: number },
): Promise<void> {
  assertTelegramStarsLivePaymentEnabled();
  const invoice = await prisma.invoice.findUnique({
    where: { payload },
    include: {
      contact: true,
    },
  });

  if (!invoice) {
    throw new Error("Unknown payment payload.");
  }

  if (invoice.status !== InvoiceStatus.PENDING) {
    throw new Error("This invoice is no longer payable.");
  }

  if (invoice.contact.telegramUserId !== String(telegramUserId)) {
    throw new Error("Invoice owner mismatch.");
  }
  if (payment.currency !== "XTR") {
    throw new Error("Telegram digital-service payments must use XTR.");
  }
  if (payment.totalAmount !== invoice.starsAmount || payment.totalAmount <= 0) {
    throw new Error("Telegram payment amount does not match the invoice.");
  }
  if (!invoice.conversationId) {
    throw new Error("Telegram invoice is not attached to a conversation.");
  }
  await assertConversationChannelDeliveryAvailable({
    conversationId: invoice.conversationId,
    channel: "telegram",
  });
}

export async function persistAndProcessTelegramSuccessfulPayment(
  params: SuccessfulPaymentInput,
): Promise<TelegramPaymentProcessingResult> {
  const normalized = normalizeSuccessfulPaymentInput(params);
  const connectionId = telegramBotConnectionId();
  const externalEventId = `${connectionId}:${normalized.telegramPaymentChargeId}`;
  const inbox = await prisma.channelEventInbox.upsert({
    where: {
      kind_externalEventId: {
        kind: RepresentativeChannelKind.TELEGRAM,
        externalEventId,
      },
    },
    create: {
      kind: RepresentativeChannelKind.TELEGRAM,
      transport: ChannelTransport.TELEGRAM,
      sourceProvider: ChannelSourceProvider.TELEGRAM,
      connectionId,
      originKey: `telegram:successful-payment:${externalEventId}`,
      transactionId: normalized.invoicePayload,
      externalEventId,
      eventType: "telegram.successful_payment",
      payload: successfulPaymentInputToJson(normalized),
      status: "PENDING",
      attemptCount: 0,
    },
    update: {},
    select: {
      id: true,
      status: true,
      payload: true,
    },
  });
  const persisted = parseSuccessfulPaymentPayload(inbox.payload);
  assertMatchingSuccessfulPayment(normalized, persisted);
  await associateTelegramPaymentInboxConversation(
    inbox.id,
    persisted.invoicePayload,
  );
  return processTelegramSuccessfulPaymentInbox(inbox.id, persisted);
}

export async function retryPendingTelegramSuccessfulPayments(
  limit = 20,
): Promise<{ examined: number; confirmed: number; retrying: number }> {
  const connectionId = telegramBotConnectionId();
  const rows = await prisma.channelEventInbox.findMany({
    where: {
      kind: RepresentativeChannelKind.TELEGRAM,
      connectionId,
      eventType: "telegram.successful_payment",
      status: { in: ["PENDING", "FAILED", "PROCESSING", "DEAD_LETTER"] },
      availableAt: { lte: new Date() },
    },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(100, Math.trunc(limit))),
    select: {
      id: true,
      payload: true,
    },
  });
  let confirmed = 0;
  let retrying = 0;
  for (const row of rows) {
    let payment: SuccessfulPaymentInput;
    try {
      payment = parseSuccessfulPaymentPayload(row.payload);
    } catch (error) {
      retrying += 1;
      await markTelegramPaymentInboxRetryable(
        row.id,
        error,
        telegramPaymentMaximumBackoffMs,
        true,
      );
      continue;
    }
    await associateTelegramPaymentInboxConversation(
      row.id,
      payment.invoicePayload,
    );
    const result = await processTelegramSuccessfulPaymentInbox(
      row.id,
      payment,
    );
    if (result.status === "confirmed") confirmed += 1;
    else retrying += 1;
  }
  return { examined: rows.length, confirmed, retrying };
}

async function processTelegramSuccessfulPaymentInbox(
  inboxId: string,
  payment: SuccessfulPaymentInput,
): Promise<TelegramPaymentProcessingResult> {
  const now = new Date();
  const claim = await prisma.channelEventInbox.updateMany({
    where: {
      id: inboxId,
      OR: [
        {
          status: { in: ["PENDING", "FAILED", "DEAD_LETTER"] },
          availableAt: { lte: now },
        },
        {
          status: "PROCESSING",
          availableAt: { lte: now },
        },
      ],
    },
    data: {
      status: "PROCESSING",
      attemptCount: { increment: 1 },
      availableAt: new Date(now.getTime() + telegramPaymentProcessingLeaseMs),
      processedAt: null,
      lastError: null,
    },
  });
  if (claim.count === 0) {
    const current = await prisma.channelEventInbox.findUnique({
      where: { id: inboxId },
      select: { status: true },
    });
    if (current?.status === "PROCESSED") {
      return {
        status: "confirmed",
        confirmation: await confirmInvoicePayment(payment),
      };
    }
    return { status: "retrying" };
  }

  try {
    const confirmation = await confirmInvoicePayment(payment);
    await prisma.channelEventInbox.update({
      where: { id: inboxId },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
        availableAt: new Date(),
        lastError: null,
      },
    });
    return { status: "confirmed", confirmation };
  } catch (error) {
    const claimed = await prisma.channelEventInbox.findUnique({
      where: { id: inboxId },
      select: { attemptCount: true },
    });
    const attemptCount = claimed?.attemptCount ?? 1;
    await markTelegramPaymentInboxRetryable(
      inboxId,
      error,
      Math.min(
        telegramPaymentMaximumBackoffMs,
        2 ** Math.min(attemptCount, 10) * 1_000,
      ),
    );
    return { status: "retrying" };
  }
}

async function associateTelegramPaymentInboxConversation(
  inboxId: string,
  invoicePayload: string,
): Promise<void> {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { payload: invoicePayload },
      select: { conversationId: true },
    });
    if (!invoice?.conversationId) return;
    await prisma.channelEventInbox.updateMany({
      where: {
        id: inboxId,
        conversationId: null,
      },
      data: {
        conversationId: invoice.conversationId,
      },
    });
  } catch (error) {
    // The payment event is already durable. Association is observability
    // enrichment and must never turn a safely persisted charge back into an
    // unacknowledged long-polling update.
    console.error(
      "Unable to associate Telegram payment inbox with its conversation:",
      error,
    );
  }
}

async function markTelegramPaymentInboxRetryable(
  inboxId: string,
  error: unknown,
  retryAfterMs: number,
  incrementAttempt = false,
): Promise<void> {
  await prisma.channelEventInbox.update({
    where: { id: inboxId },
    data: {
      status: "FAILED",
      ...(incrementAttempt ? { attemptCount: { increment: 1 } } : {}),
      processedAt: null,
      availableAt: new Date(
        Date.now()
        + Math.max(1_000, Math.min(telegramPaymentMaximumBackoffMs, retryAfterMs)),
      ),
      lastError:
        error instanceof Error
          ? error.message.slice(0, 1_000)
          : "telegram_payment_fulfillment_failed",
    },
  });
}

export async function confirmInvoicePayment(
  params: SuccessfulPaymentInput,
): Promise<TelegramPaymentConfirmation> {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { payload: params.invoicePayload },
      include: {
        representative: {
          include: {
            owner: {
              include: {
                wallet: true,
              },
            },
          },
        },
        contact: true,
        conversation: true,
      },
    });

    if (!invoice) {
      throw new Error("Unknown payment payload.");
    }

    if (params.currency !== "XTR") {
      throw new Error("Telegram digital-service payments must use XTR.");
    }
    if (params.totalAmount !== invoice.starsAmount || params.totalAmount <= 0) {
      throw new Error("Telegram payment amount does not match the invoice.");
    }
    if (
      !invoice.contact.telegramUserId
      || invoice.contact.telegramUserId !== String(params.telegramUserId)
    ) {
      throw new Error("Invoice owner mismatch.");
    }
    if (!params.telegramPaymentChargeId.trim()) {
      throw new Error("Telegram payment charge id is required.");
    }

    if (invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.FULFILLED) {
      if (invoice.telegramPaymentChargeId !== params.telegramPaymentChargeId) {
        throw new Error("Invoice was already paid by a different Telegram charge.");
      }
      return {
        planName: invoice.title,
        starsAmount: invoice.starsAmount,
        representativeSlug: invoice.representative.slug,
        representativeId: invoice.representativeId,
        contactId: invoice.contactId,
        ...(invoice.conversationId ? { conversationId: invoice.conversationId } : {}),
        planType: mapPricingPlanTypeFromDb(invoice.planType),
      };
    }
    if (invoice.status !== InvoiceStatus.PENDING) {
      throw new Error(`Invoice cannot be paid from status ${invoice.status}.`);
    }

    const duplicateCharge = await tx.invoice.findUnique({
      where: { telegramPaymentChargeId: params.telegramPaymentChargeId },
      select: { id: true },
    });
    if (duplicateCharge && duplicateCharge.id !== invoice.id) {
      throw new Error("Telegram payment charge was already used for another invoice.");
    }

    const servicePaymentOrder =
      invoice.planType === PricingPlanType.SPONSOR
        ? null
        : await tx.servicePaymentOrder.findUnique({
            where: { id: `service-payment:${invoice.id}` },
            select: { providerAccountId: true },
          });
    if (
      invoice.planType !== PricingPlanType.SPONSOR &&
      !servicePaymentOrder
    ) {
      throw new Error("Telegram service payment order is missing.");
    }

    const paidAt = new Date();

    const claimed = await tx.invoice.updateMany({
      where: {
        id: invoice.id,
        status: InvoiceStatus.PENDING,
        telegramPaymentChargeId: null,
      },
      data: {
        status: invoice.planType === PricingPlanType.SPONSOR ? InvoiceStatus.FULFILLED : InvoiceStatus.PAID,
        paidAt,
        telegramPaymentChargeId: params.telegramPaymentChargeId,
        providerPaymentChargeId: params.providerPaymentChargeId ?? null,
      },
    });
    if (claimed.count !== 1) {
      throw new Error("Invoice payment was confirmed concurrently.");
    }

    if (invoice.representative.owner.wallet) {
      await tx.wallet.update({
        where: { ownerId: invoice.representative.owner.id },
        data: {
          starsBalance: {
            increment: params.totalAmount,
          },
          ...(invoice.planType === PricingPlanType.SPONSOR
            ? {
                sponsorPoolCredit: {
                  increment: params.totalAmount,
                },
              }
            : {}),
        },
      });
    } else {
      await tx.wallet.create({
        data: {
          ownerId: invoice.representative.owner.id,
          starsBalance: params.totalAmount,
          sponsorPoolCredit: invoice.planType === PricingPlanType.SPONSOR ? params.totalAmount : 0,
          balanceCredits: 0,
        },
      });
    }

    await tx.contact.update({
      where: { id: invoice.contactId },
      data: {
        isPaid: true,
        stage:
          invoice.planType === PricingPlanType.DEEP_HELP
            ? ContactStage.WAITING_ON_OWNER
            : ContactStage.QUALIFIED,
      },
    });

    if (invoice.conversationId) {
      await tx.$executeRaw`
        SELECT "id"
        FROM "Conversation"
        WHERE "id" = ${invoice.conversationId}
        FOR UPDATE
      `;
      const lockedConversation = await tx.conversation.findUnique({
        where: { id: invoice.conversationId },
        select: { computeBudgetRemainingCredits: true },
      });
      if (!lockedConversation) {
        throw new Error("Invoice conversation is no longer available.");
      }
      const nextComputeBudget =
        (lockedConversation.computeBudgetRemainingCredits ?? 0) +
        computeCreditsForPlan(invoice.planType);
      await tx.conversation.update({
        where: { id: invoice.conversationId },
        data: {
          ...(invoice.planType === PricingPlanType.PASS
            ? {
                passUnlockedAt: paidAt,
                computeBudgetRemainingCredits: nextComputeBudget,
              }
            : {}),
          ...(invoice.planType === PricingPlanType.DEEP_HELP
            ? {
                deepHelpUnlockedAt: paidAt,
                computeBudgetRemainingCredits: nextComputeBudget,
              }
            : {}),
        },
      });
    }

    if (invoice.planType !== PricingPlanType.SPONSOR) {
      if (!invoice.contact.audienceIdentityId) {
        throw new Error("Telegram payer does not have a canonical audience identity.");
      }
      await fulfillServicePaymentOrder(
        {
          paymentOrderId: `service-payment:${invoice.id}`,
          provider: PaymentProvider.TELEGRAM_STARS,
          providerAccountId: servicePaymentOrder!.providerAccountId,
          providerOrderId: invoice.payload,
          providerEventId: params.telegramPaymentChargeId,
          payerAudienceIdentityId: invoice.contact.audienceIdentityId,
          amountMinor: params.totalAmount,
          currency: params.currency,
          verifiedAt: paidAt,
          rawPayload: {
            invoicePayload: params.invoicePayload,
            telegramPaymentChargeId: params.telegramPaymentChargeId,
            providerPaymentChargeId: params.providerPaymentChargeId ?? null,
            telegramUserId: params.telegramUserId,
          },
        },
        tx as never,
      );
    }

    await tx.eventAudit.create({
      data: {
        representativeId: invoice.representativeId,
        contactId: invoice.contactId,
        conversationId: invoice.conversationId,
        type: EventType.PAYMENT_CONFIRMED,
        payload: {
          invoiceId: invoice.id,
          amount: params.totalAmount,
          status:
            invoice.planType === PricingPlanType.SPONSOR ? InvoiceStatus.FULFILLED : InvoiceStatus.PAID,
        },
      },
    });

    return {
      planName: invoice.title,
      starsAmount: invoice.starsAmount,
      representativeSlug: invoice.representative.slug,
      representativeId: invoice.representativeId,
      contactId: invoice.contactId,
      ...(invoice.conversationId ? { conversationId: invoice.conversationId } : {}),
      planType: mapPricingPlanTypeFromDb(invoice.planType),
    };
  });
}

export function buildInvoicePayload(invoiceId: string): string {
  return `delegate:invoice:${invoiceId}`;
}

function normalizeSuccessfulPaymentInput(
  input: SuccessfulPaymentInput,
): SuccessfulPaymentInput {
  const invoicePayload = input.invoicePayload.trim();
  const currency = input.currency.trim().toUpperCase();
  const telegramPaymentChargeId = input.telegramPaymentChargeId.trim();
  const providerPaymentChargeId = input.providerPaymentChargeId?.trim();
  if (!invoicePayload) throw new Error("Telegram payment invoice payload is required.");
  if (!telegramPaymentChargeId) {
    throw new Error("Telegram payment charge id is required.");
  }
  if (!Number.isSafeInteger(input.totalAmount) || input.totalAmount <= 0) {
    throw new Error("Telegram payment amount must be a positive integer.");
  }
  if (!Number.isSafeInteger(input.telegramUserId) || input.telegramUserId <= 0) {
    throw new Error("Telegram payer id must be a positive integer.");
  }
  return {
    invoicePayload,
    totalAmount: input.totalAmount,
    currency,
    telegramUserId: input.telegramUserId,
    telegramPaymentChargeId,
    ...(providerPaymentChargeId ? { providerPaymentChargeId } : {}),
  };
}

function successfulPaymentInputToJson(
  input: SuccessfulPaymentInput,
): Prisma.InputJsonObject {
  return {
    invoicePayload: input.invoicePayload,
    totalAmount: input.totalAmount,
    currency: input.currency,
    telegramUserId: input.telegramUserId,
    telegramPaymentChargeId: input.telegramPaymentChargeId,
    ...(input.providerPaymentChargeId
      ? { providerPaymentChargeId: input.providerPaymentChargeId }
      : {}),
  };
}

function parseSuccessfulPaymentPayload(payload: unknown): SuccessfulPaymentInput {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Persisted Telegram payment event is malformed.");
  }
  const value = payload as Record<string, unknown>;
  if (
    typeof value.invoicePayload !== "string"
    || typeof value.totalAmount !== "number"
    || typeof value.currency !== "string"
    || typeof value.telegramUserId !== "number"
    || typeof value.telegramPaymentChargeId !== "string"
    || (
      value.providerPaymentChargeId !== undefined
      && value.providerPaymentChargeId !== null
      && typeof value.providerPaymentChargeId !== "string"
    )
  ) {
    throw new Error("Persisted Telegram payment event is malformed.");
  }
  return normalizeSuccessfulPaymentInput({
    invoicePayload: value.invoicePayload,
    totalAmount: value.totalAmount,
    currency: value.currency,
    telegramUserId: value.telegramUserId,
    telegramPaymentChargeId: value.telegramPaymentChargeId,
    ...(typeof value.providerPaymentChargeId === "string"
      ? { providerPaymentChargeId: value.providerPaymentChargeId }
      : {}),
  });
}

function assertMatchingSuccessfulPayment(
  incoming: SuccessfulPaymentInput,
  persisted: SuccessfulPaymentInput,
) {
  if (
    incoming.invoicePayload !== persisted.invoicePayload
    || incoming.totalAmount !== persisted.totalAmount
    || incoming.currency !== persisted.currency
    || incoming.telegramUserId !== persisted.telegramUserId
    || incoming.telegramPaymentChargeId !== persisted.telegramPaymentChargeId
    || (incoming.providerPaymentChargeId ?? null)
      !== (persisted.providerPaymentChargeId ?? null)
  ) {
    throw new Error(
      "Telegram payment charge was replayed with conflicting payment data.",
    );
  }
}

function telegramBotConnectionId(): string {
  const configuredId = process.env.TELEGRAM_BOT_ID?.trim();
  const tokenId = process.env.TELEGRAM_BOT_TOKEN?.trim().match(/^([1-9]\d*):/)?.[1];
  const connectionId = configuredId || tokenId;
  if (!connectionId || !/^[1-9]\d*$/.test(connectionId)) {
    throw new Error(
      "Telegram runtime requires TELEGRAM_BOT_ID or a token with a numeric bot id.",
    );
  }
  return connectionId;
}

function buildOwnerAction(plan: ConversationPlan): string {
  switch (plan.intent) {
    case "refund":
      return "Approve or decline refund before sending a human response.";
    case "media":
      return "Confirm whether the founder wants to take this media request.";
    case "scheduling":
      return "Confirm whether to expose a candidate time window.";
    case "pricing":
    case "collaboration":
      return "Review context, budget, and decide whether to take the lead personally.";
    default:
      return "Review the request and decide whether the owner should step in.";
  }
}

function mapComputeNetworkModeFromDb(value: ComputeNetworkMode) {
  return value.toLowerCase() as "no_network" | "allowlist" | "full";
}

function mapComputeFilesystemModeFromDb(value: ComputeFilesystemMode) {
  return value.toLowerCase() as "workspace_only" | "read_only_workspace" | "ephemeral_full";
}

function computeCreditsForPlan(planType: PricingPlanType): number {
  switch (planType) {
    case PricingPlanType.DEEP_HELP:
      return 180;
    case PricingPlanType.PASS:
      return 60;
    default:
      return 0;
  }
}

function calculatePriority(plan: ConversationPlan): number {
  if (plan.intent === "refund") {
    return 95;
  }
  if (plan.suggestedPlan === "deep_help") {
    return 88;
  }
  if (plan.intent === "media") {
    return 68;
  }
  return 78;
}

function summarizeText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function mapPricingPlanTypeFromDb(value: PricingPlanType): PlanTier {
  switch (value) {
    case PricingPlanType.PASS:
      return "pass";
    case PricingPlanType.DEEP_HELP:
      return "deep_help";
    case PricingPlanType.SPONSOR:
      return "sponsor";
    case PricingPlanType.FREE:
    default:
      return "free";
  }
}

function mapPricingPlanTypeToDb(value: PlanTier): PricingPlanType {
  switch (value) {
    case "pass":
      return PricingPlanType.PASS;
    case "deep_help":
      return PricingPlanType.DEEP_HELP;
    case "sponsor":
      return PricingPlanType.SPONSOR;
    case "free":
    default:
      return PricingPlanType.FREE;
  }
}
