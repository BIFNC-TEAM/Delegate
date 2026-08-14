import { createHash } from "node:crypto";

import {
  ContactStage,
  ConversationEpisodeStatus,
  EventType,
  LeadStatus,
  Prisma,
} from "@prisma/client";

import { createConversationServiceRequestInTransaction } from "./delegation-tasks";
import { prisma } from "./prisma";

export type CompleteConversationIntakeInput = {
  representativeId: string;
  representativeVersionId?: string | null;
  contactId: string;
  conversationId: string;
  episodeId?: string | null;
  inputMessageId: string;
  intent: string;
  collectorKind: string;
  sourceChannel: string;
  summary: string;
  objective: string;
  desiredOutcome: string;
  priority: number;
  recommendedNextStep: string;
  payload: Prisma.InputJsonValue;
};

/**
 * Completes request-description intake as one idempotent transaction.
 * No tool, approval, payment, or external-effect authority is granted here.
 */
export async function completeConversationIntake(input: CompleteConversationIntakeInput) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))`;
    const conversation = await tx.conversation.findUnique({
      where: { id: input.conversationId },
      include: {
        contact: true,
        episodes: { orderBy: { sequence: "desc" }, take: 1 },
      },
    });
    if (
      !conversation
      || conversation.representativeId !== input.representativeId
      || conversation.contactId !== input.contactId
    ) {
      throw new Error("Intake context does not match the conversation.");
    }

    const latestEpisode = conversation.episodes[0];
    const humanActive =
      conversation.state === "HUMAN_ACTIVE"
      || conversation.state === "NEEDS_HUMAN"
      || latestEpisode?.status === ConversationEpisodeStatus.HUMAN_ACTIVE
      || latestEpisode?.status === ConversationEpisodeStatus.NEEDS_HUMAN;
    if (humanActive) {
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { collectorState: Prisma.JsonNull },
      });
      return {
        serviceRequestId: null,
        intakeSubmissionId: null,
        leadId: null,
        skipped: "human_active" as const,
      };
    }

    const serviceRequest = await createConversationServiceRequestInTransaction(tx, {
      representativeId: input.representativeId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      ...(input.representativeVersionId !== undefined
        ? { representativeVersionId: input.representativeVersionId }
        : {}),
      ...(input.episodeId !== undefined ? { episodeId: input.episodeId } : {}),
      inputMessageId: input.inputMessageId,
      intent: input.intent,
      objective: input.objective,
      desiredOutcome: input.desiredOutcome,
      priority: input.priority,
    });

    const intakeId = deterministicRecordId("intake", input.inputMessageId);
    const intake = await tx.intakeSubmission.upsert({
      where: { id: intakeId },
      update: {},
      create: {
        id: intakeId,
        representativeId: input.representativeId,
        contactId: input.contactId,
        conversationId: input.conversationId,
        requestType: input.intent,
        payload: input.payload,
        priorityScore: clampPriority(input.priority),
        recommendedNextStep: input.recommendedNextStep,
      },
    });

    const existingLead = await tx.lead.findFirst({
      where: {
        conversationId: conversation.id,
        status: { notIn: [LeadStatus.WON, LeadStatus.LOST, LeadStatus.ARCHIVED] },
      },
      orderBy: { updatedAt: "desc" },
    });
    const leadTitle = `${conversation.contact.displayName || conversation.contact.username || "New contact"} · ${input.intent || "inquiry"}`;
    const lead = existingLead
      ? await tx.lead.update({
          where: { id: existingLead.id },
          data: {
            intakeSubmissionId: intake.id,
            ...(latestEpisode ? { episodeId: latestEpisode.id } : {}),
            kind: input.intent || existingLead.kind,
            title: leadTitle,
            summary: input.summary,
            priority: clampPriority(input.priority),
            status: LeadStatus.QUALIFIED,
            source: input.sourceChannel || existingLead.source,
          },
        })
      : await tx.lead.create({
          data: {
            representativeId: conversation.representativeId,
            contactId: conversation.contactId,
            conversationId: conversation.id,
            ...(latestEpisode ? { episodeId: latestEpisode.id } : {}),
            intakeSubmissionId: intake.id,
            kind: input.intent || "general",
            title: leadTitle,
            summary: input.summary,
            priority: clampPriority(input.priority),
            status: LeadStatus.QUALIFIED,
            source: input.sourceChannel || conversation.sourceChannel || "conversation",
          },
        });

    await tx.contact.update({
      where: { id: conversation.contactId },
      data: { stage: ContactStage.QUALIFIED },
    });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { collectorState: Prisma.JsonNull, state: "ACTIVE" },
    });
    await tx.eventAudit.upsert({
      where: { id: deterministicRecordId("audit", input.inputMessageId) },
      update: {},
      create: {
        id: deterministicRecordId("audit", input.inputMessageId),
        representativeId: input.representativeId,
        contactId: input.contactId,
        conversationId: input.conversationId,
        delegationTaskId: serviceRequest.task?.id ?? null,
        type: EventType.INTAKE_SUBMITTED,
        payload: {
          intakeSubmissionId: intake.id,
          collectorKind: input.collectorKind,
          summary: input.summary,
          priority: clampPriority(input.priority),
        },
      },
    });

    return {
      serviceRequestId: serviceRequest.task?.id ?? null,
      intakeSubmissionId: intake.id,
      leadId: lead.id,
      skipped: serviceRequest.skipped,
    };
  });
}

function deterministicRecordId(prefix: string, inputMessageId: string) {
  const digest = createHash("sha256").update(inputMessageId).digest("hex").slice(0, 32);
  return `${prefix}_${digest}`;
}

function clampPriority(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
