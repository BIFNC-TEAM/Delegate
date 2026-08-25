import {
  ActionAuthorizationPhase,
  ConversationPlanActionKind,
  ConversationPlanActionStatus,
  ConversationPlanSideEffectClass,
  ConversationTurnPlanStatus,
  GenerationRunStatus,
  PolicyDecision,
  Prisma,
} from "@prisma/client";
import type {
  CapabilityCatalog,
  CapabilityCatalogV3,
  CapabilityDescriptor,
  CapabilityDefinitionV3,
  ComposerEvidenceReferenceV3,
  KnowledgeFallbackActivationV3,
  PlanAction,
  PlanActionV3,
  PlanScopeKeyV3,
  TurnEnvelope,
  TurnPlanV2,
  TurnPlanV3,
} from "@delegate/runtime";
import {
  resolveGoalOutcomesV3,
  turnPlanV3Schema,
  validateComposedMessageDraftV3,
  validateTurnPlanV3,
} from "@delegate/runtime";
import sha256Digest from "fast-sha256";

import { prisma } from "./prisma";

export type PersistConversationTurnPlanInput = {
  representativeId: string;
  representativeVersionId?: string | null;
  conversationId: string;
  generationRunId?: string | null;
  inputMessageId: string;
  delegationTaskId?: string | null;
  envelope: TurnEnvelope;
  catalog: CapabilityCatalog;
  plan: TurnPlanV2;
  plannerProvider: string;
  plannerModel: string;
  promptVersion: string;
  shadowMode: boolean;
  generationWorkLease?: {
    outboxId: string;
    leaseAttempt: number;
  };
};

export type PersistConversationTurnPlanV3Input = {
  representativeId: string;
  representativeVersionId?: string | null;
  conversationId: string;
  generationRunId?: string | null;
  inputMessageId: string;
  delegationTaskId?: string | null;
  envelope: TurnEnvelope;
  catalog: CapabilityCatalogV3;
  plan: TurnPlanV3;
  plannerProvider: string;
  plannerModel: string;
  promptVersion: string;
  plannerProposalHash?: string | null;
  plannerProposalSnapshot?: unknown;
  shadowComparison?: Record<string, unknown>;
  shadowMode: boolean;
  generationWorkLease?: {
    outboxId: string;
    leaseAttempt: number;
  };
};

export async function persistConversationTurnPlan(
  input: PersistConversationTurnPlanInput,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))
    `;
    return persistConversationTurnPlanInTransaction(tx, input);
  });
}

export async function persistConversationTurnPlanV3(
  input: PersistConversationTurnPlanV3Input,
) {
  const scopeKey = buildPlanScopeStorageKeyV3(input.plan.scopeKey);
  assertPlanScopeMatchesPersistenceContext(input.plan.scopeKey, input);
  const validated = validateTurnPlanV3({
    plan: input.plan,
    catalog: input.catalog,
    envelope: input.envelope,
    expectedPlanId: input.plan.planId,
  });
  if (!validated.ok) {
    throw new Error(
      `TurnPlan V3 failed persistence validation: ${validated.issues
        .map((issue) => `${issue.code}:${issue.path}`)
        .join(",")}`,
    );
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))
    `;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${scopeKey}))
    `;
    return persistConversationTurnPlanV3InTransaction(tx, input, scopeKey);
  });
}

export async function persistConversationTurnPlannerFailureV3(input: {
  planId: string;
  revision: number;
  scopeKey: PlanScopeKeyV3;
  representativeId: string;
  representativeVersionId?: string | null;
  conversationId: string;
  generationRunId?: string | null;
  inputMessageId: string;
  envelope: TurnEnvelope;
  catalog: CapabilityCatalogV3;
  plannerProvider?: string;
  plannerModel?: string;
  promptVersion: string;
  validationPolicyVersion: string;
  code: string;
  reason: string;
  issues?: unknown;
  plannerProposalHash?: string | null;
  plannerProposalSnapshot?: unknown;
  generationWorkLease?: {
    outboxId: string;
    leaseAttempt: number;
  };
}) {
  const scopeKey = buildPlanScopeStorageKeyV3(input.scopeKey);
  assertPlanScopeMatchesPersistenceContext(input.scopeKey, input);
  if (
    typeof input.plannerProposalSnapshot !== "undefined"
    && Buffer.byteLength(JSON.stringify(input.plannerProposalSnapshot), "utf8")
      > 512 * 1024
  ) {
    throw new Error("TurnPlan V3 failure proposal exceeds the persistence boundary.");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))
    `;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${scopeKey}))
    `;
    await assertTurnPlanContextInTransaction(tx, input);
    const existing = await tx.conversationTurnPlan.findUnique({
      where: { id: input.planId },
    });
    if (existing) return existing;
    const latest = await tx.conversationTurnPlan.findFirst({
      where: {
        conversationId: input.conversationId,
        inputMessageId: input.inputMessageId,
      },
      orderBy: { revision: "desc" },
      select: { revision: true },
    });
    if (input.revision !== (latest?.revision ?? 0) + 1) {
      throw new Error("TurnPlan V3 failure revision is no longer current.");
    }
    const failure = {
      code: input.code,
      reason: input.reason,
      issues: input.issues ?? null,
    };
    const now = new Date();
    return tx.conversationTurnPlan.create({
      data: {
        id: input.planId,
        representativeId: input.representativeId,
        representativeVersionId: input.representativeVersionId ?? null,
        conversationId: input.conversationId,
        generationRunId: input.generationRunId ?? null,
        inputMessageId: input.inputMessageId,
        schemaVersion: "turn-plan.v3",
        protocolVersion: 3,
        scopeKey,
        scopeSnapshot: input.scopeKey as unknown as Prisma.InputJsonValue,
        executionEpoch: 0,
        promptVersion: input.promptVersion,
        capabilityCatalogHash: stripSha256Prefix(input.catalog.catalogHash),
        planHash: hashCanonical(failure),
        revision: input.revision,
        status: ConversationTurnPlanStatus.FAILED,
        mode: "planner_failure",
        objective: input.envelope.currentMessage.text.slice(0, 2_000),
        language: input.envelope.currentMessage.language,
        requestHash: hashCanonical({
          currentMessage: input.envelope.currentMessage,
          attachments: input.envelope.attachments,
        }),
        plannerProvider: input.plannerProvider ?? null,
        plannerModel: input.plannerModel ?? null,
        plannerProposalHash: input.plannerProposalHash
          ? stripSha256Prefix(input.plannerProposalHash)
          : null,
        plannerProposalSnapshot: typeof input.plannerProposalSnapshot === "undefined"
          ? Prisma.JsonNull
          : input.plannerProposalSnapshot as Prisma.InputJsonValue,
        validationPolicyVersion: input.validationPolicyVersion,
        planSnapshot: failure as Prisma.InputJsonObject,
        validationResult: failure as Prisma.InputJsonObject,
        shadowMode: true,
        failedAt: now,
      },
    });
  });
}

export async function persistConversationTurnPlanV3InTransaction(
  tx: Prisma.TransactionClient,
  input: PersistConversationTurnPlanV3Input,
  scopeKey = buildPlanScopeStorageKeyV3(input.plan.scopeKey),
) {
  await assertTurnPlanContextInTransaction(tx, input);
  assertPlanScopeMatchesPersistenceContext(input.plan.scopeKey, input);
  const planHash = hashCanonical(input.plan);
  const requestHash = hashCanonical({
    currentMessage: input.envelope.currentMessage,
    attachments: input.envelope.attachments.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    })),
  });
  const existingById = await tx.conversationTurnPlan.findUnique({
    where: { id: input.plan.planId },
    include: { actions: { orderBy: { sequence: "asc" } } },
  });
  if (existingById) {
    if (
      existingById.protocolVersion !== 3
      || existingById.scopeKey !== scopeKey
      || existingById.planHash !== planHash
      || existingById.conversationId !== input.conversationId
      || existingById.inputMessageId !== input.inputMessageId
    ) {
      throw new Error("TurnPlan V3 id already belongs to a different immutable plan.");
    }
    return existingById;
  }

  const [latestRevision, previousV3, currentFence] = await Promise.all([
    tx.conversationTurnPlan.findFirst({
      where: {
        conversationId: input.conversationId,
        inputMessageId: input.inputMessageId,
      },
      orderBy: { revision: "desc" },
      select: { revision: true },
    }),
    tx.conversationTurnPlan.findFirst({
      where: { scopeKey, protocolVersion: 3 },
      orderBy: { revision: "desc" },
      select: { id: true, status: true },
    }),
    tx.planExecutionFence.findUnique({ where: { scopeKey } }),
  ]);
  const revision = (latestRevision?.revision ?? 0) + 1;
  if (input.plan.revision !== revision) {
    throw new Error(
      `TurnPlan V3 revision ${input.plan.revision} does not match server revision ${revision}.`,
    );
  }
  if (previousV3 && !isTerminalPlanStatus(previousV3.status)) {
    await tx.conversationTurnPlan.update({
      where: { id: previousV3.id },
      data: { status: ConversationTurnPlanStatus.SUPERSEDED },
    });
  }

  const descriptors = new Map(
    input.catalog.capabilities.map((definition) => [
      `${definition.key}@${definition.version}`,
      definition,
    ]),
  );
  const actionIds = new Map(
    input.plan.actions.map((action) => [
      action.id,
      deterministicPlanActionId(input.plan.planId, action.id),
    ]),
  );
  const now = new Date();
  const executionEpoch = input.shadowMode
    ? 0
    : (currentFence?.executionEpoch ?? 0) + 1;
  const created = await tx.conversationTurnPlan.create({
    data: {
      id: input.plan.planId,
      representativeId: input.representativeId,
      representativeVersionId: input.representativeVersionId ?? null,
      conversationId: input.conversationId,
      generationRunId: input.generationRunId ?? null,
      inputMessageId: input.inputMessageId,
      delegationTaskId: input.delegationTaskId ?? null,
      supersedesPlanId: previousV3?.id ?? null,
      schemaVersion: "turn-plan.v3",
      protocolVersion: 3,
      scopeKey,
      scopeSnapshot: input.plan.scopeKey as unknown as Prisma.InputJsonValue,
      executionEpoch,
      promptVersion: input.promptVersion,
      capabilityCatalogHash: stripSha256Prefix(input.catalog.catalogHash),
      planHash,
      revision,
      status: ConversationTurnPlanStatus.VALIDATED,
      mode: "v3",
      objective: input.plan.objective,
      language: input.envelope.currentMessage.language,
      requestHash,
      plannerProvider: input.plannerProvider,
      plannerModel: input.plannerModel,
      plannerProposalHash: input.plannerProposalHash
        ? stripSha256Prefix(input.plannerProposalHash)
        : null,
      plannerProposalSnapshot: typeof input.plannerProposalSnapshot === "undefined"
        ? Prisma.JsonNull
        : input.plannerProposalSnapshot as Prisma.InputJsonValue,
      validationPolicyVersion: input.plan.validationPolicyVersion,
      planSnapshot: input.plan as unknown as Prisma.InputJsonValue,
      completionCriteria:
        input.plan.deliverables as unknown as Prisma.InputJsonValue,
      validationResult: {
        ok: true,
        protocolVersion: 3,
        validatedAt: now.toISOString(),
        shadowComparison: input.shadowComparison
          ? input.shadowComparison as Prisma.InputJsonObject
          : null,
      },
      shadowMode: input.shadowMode,
      validatedAt: now,
      actions: {
        create: input.plan.actions.map((action, index) => {
          const definition = descriptors.get(
            `${action.capability.key}@${action.capability.version}`,
          );
          if (!definition) {
            throw new Error(
              `Validated TurnPlan V3 lost capability ${action.capability.key}@${action.capability.version}.`,
            );
          }
          return serializePlanActionV3({
            planId: input.plan.planId,
            action,
            definition,
            sequence: index + 1,
            actionIds,
          });
        }),
      },
    },
    include: { actions: { orderBy: { sequence: "asc" } } },
  });
  if (!input.shadowMode) {
    if (currentFence && currentFence.activePlanId !== created.id) {
      await supersedePlanExecutionInTransaction(
        tx,
        currentFence.activePlanId,
        now,
      );
    }
    await tx.planExecutionFence.upsert({
      where: { scopeKey },
      create: {
        scopeKey,
        activePlanId: created.id,
        activeRevision: revision,
        executionEpoch,
      },
      update: {
        activePlanId: created.id,
        activeRevision: revision,
        executionEpoch,
      },
    });
  }
  return created;
}

async function supersedePlanExecutionInTransaction(
  tx: Prisma.TransactionClient,
  planId: string,
  now: Date,
) {
  const actions = await tx.conversationPlanAction.findMany({
    where: { turnPlanId: planId },
    select: { id: true },
  });
  const actionIds = actions.map((action) => action.id);
  const attempts = actionIds.length
    ? await tx.toolExecution.findMany({
        where: { planActionId: { in: actionIds } },
        select: {
          id: true,
          planActionId: true,
          status: true,
          attemptPhase: true,
          executionOutboxId: true,
        },
      })
    : [];
  const attemptIds = attempts.map((attempt) => attempt.id);
  const preCallAttempts = attempts.filter((attempt) =>
    attempt.status === "QUEUED"
    || attempt.status === "BLOCKED"
    || (
      attempt.status === "RUNNING"
      && ["CREATED", "CLAIMED", "CALL_PREPARED"].includes(
        attempt.attemptPhase ?? "",
      )
    ));
  const startedAttempts = attempts.filter((attempt) =>
    attempt.status === "RUNNING"
    && ["CALL_STARTED", "RESPONSE_RECEIVED", "VERIFYING"].includes(
      attempt.attemptPhase ?? "",
    ));
  const startedActionIds = [...new Set(startedAttempts.flatMap((attempt) =>
    attempt.planActionId ? [attempt.planActionId] : []))];
  const deliveryAttempts = actionIds.length
    ? await tx.messageDeliveryAttempt.findMany({
        where: { planActionId: { in: actionIds } },
        select: {
          id: true,
          messageId: true,
          status: true,
          attemptPhase: true,
          deliveryOutboxId: true,
          deliveryLeaseAttempt: true,
          externalMessageId: true,
        },
      })
    : [];
  const preCallDeliveries = deliveryAttempts.filter((attempt) =>
    attempt.status === "QUEUED"
    || (
      attempt.status === "PROCESSING"
      && ["CREATED", "CLAIMED", "CALL_PREPARED"].includes(
        attempt.attemptPhase,
      )
    ));
  const uncertainDeliveries = deliveryAttempts.filter((attempt) =>
    attempt.status === "RECONCILIATION_REQUIRED"
    || (
      attempt.status === "PROCESSING"
      && [
        "CALL_STARTED",
        "RESPONSE_RECEIVED",
        "OUTCOME_UNKNOWN",
        "RECONCILIATION_REQUIRED",
      ].includes(attempt.attemptPhase)
    ));
  const acceptedDeliveries = deliveryAttempts.filter((attempt) =>
    attempt.status === "PROVIDER_ACCEPTED"
    && Boolean(attempt.externalMessageId));
  const undeliveredPlanResult = deliveryAttempts.length === 0
    ? await tx.conversationTurnPlan.findUnique({
        where: { id: planId },
        select: {
          generationRun: {
            select: {
              id: true,
              status: true,
              outputMessageId: true,
            },
          },
        },
      })
    : null;
  await tx.conversationTurnPlan.updateMany({
    where: {
      id: planId,
      status: { notIn: ["COMPLETED", "FAILED", "CANCELED", "SUPERSEDED"] },
    },
    data: { status: "SUPERSEDED", completedAt: now },
  });
  if (actionIds.length) {
    await tx.conversationPlanAction.updateMany({
      where: {
        id: { in: actionIds },
        status: { in: ["PLANNED", "AUTHORIZING", "WAITING_APPROVAL", "READY", "QUEUED"] },
      },
      data: { status: "CANCELED", completedAt: now },
    });
    await tx.toolExecution.updateMany({
      where: {
        id: { in: preCallAttempts.map((attempt) => attempt.id) },
      },
      data: {
        status: "CANCELED",
        attemptPhase: "CANCELED_BEFORE_START",
        executionLeaseToken: null,
        finishedAt: now,
      },
    });
    const preCallOutboxIds = preCallAttempts.flatMap((attempt) =>
      attempt.executionOutboxId ? [attempt.executionOutboxId] : []);
    if (preCallOutboxIds.length) {
      await tx.outboxEvent.updateMany({
        where: {
          id: { in: preCallOutboxIds },
          eventType: "action.execution.requested",
          status: { in: ["PENDING", "PROCESSING", "FAILED"] },
        },
        data: {
          status: "DEAD_LETTER",
          processedAt: now,
          lastError: "turn_plan_superseded_before_call",
        },
      });
    }
    if (attemptIds.length) {
      await tx.approvalRequest.updateMany({
        where: {
          status: "PENDING",
          toolExecutionId: { in: attemptIds },
        },
        data: {
          status: "EXPIRED",
          resolvedAt: now,
          resolvedBy: "turn-plan-supersession",
          decisionNote: "The approved action intent was superseded before execution.",
        },
      });
    }
    await tx.delegationTaskExternalEffect.updateMany({
      where: {
        planActionId: { in: actionIds },
        status: { in: ["PROPOSED", "WAITING_APPROVAL", "APPROVED"] },
      },
      data: { status: "CANCELED", failureReason: "turn_plan_superseded" },
    });
    if (startedActionIds.length) {
      await tx.conversationPlanAction.updateMany({
        where: {
          id: { in: startedActionIds },
          status: "EXECUTING",
        },
        data: { status: "RECONCILIATION_REQUIRED" },
      });
      await tx.delegationTaskExternalEffect.updateMany({
        where: {
          planActionId: { in: startedActionIds },
          status: "EXECUTING",
        },
        data: {
          status: "RECONCILIATION_REQUIRED",
          failureReason: "turn_plan_superseded_after_call_started",
        },
      });
      await tx.billableUnit.updateMany({
        where: {
          planId,
          actionId: { in: startedActionIds },
          status: { in: ["RESERVED", "TRANSFERRED", "SETTLEMENT_PENDING"] },
        },
        data: {
          status: "HELD_FOR_RECONCILIATION",
          reconciliationHeldAt: now,
        },
      });
    }
    const preCallDeliveryIds = preCallDeliveries.map((attempt) => attempt.id);
    if (preCallDeliveryIds.length) {
      await tx.messageDeliveryAttempt.updateMany({
        where: { id: { in: preCallDeliveryIds } },
        data: {
          status: "CANCELED",
          attemptPhase: "CANCELED_BEFORE_START",
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: now,
          failureCode: "turn_plan_superseded_before_delivery",
          failureReason:
            "Delivery was canceled before provider execution because its TurnPlan revision was superseded.",
        },
      });
      await tx.message.updateMany({
        where: {
          id: { in: preCallDeliveries.map((attempt) => attempt.messageId) },
          deliveryStatus: { in: ["QUEUED", "PROCESSING", "FAILED"] },
        },
        data: {
          deliveryStatus: "CANCELED",
          failureCode: "turn_plan_superseded_before_delivery",
          failureReason:
            "Delivery was canceled because its TurnPlan revision was superseded.",
        },
      });
      const preCallDeliveryOutboxIds = preCallDeliveries.flatMap((attempt) =>
        attempt.deliveryOutboxId ? [attempt.deliveryOutboxId] : []);
      if (preCallDeliveryOutboxIds.length) {
        await tx.outboxEvent.updateMany({
          where: {
            id: { in: preCallDeliveryOutboxIds },
            status: { in: ["PENDING", "PROCESSING", "FAILED"] },
          },
          data: {
            status: "DEAD_LETTER",
            processedAt: now,
            lastError: "turn_plan_superseded_before_delivery",
          },
        });
      }
    }
    const uncertainDeliveryIds = uncertainDeliveries.map((attempt) => attempt.id);
    if (uncertainDeliveryIds.length) {
      await tx.messageDeliveryAttempt.updateMany({
        where: { id: { in: uncertainDeliveryIds } },
        data: {
          status: "RECONCILIATION_REQUIRED",
          attemptPhase: "OUTCOME_UNKNOWN",
          leaseExpiresAt: null,
          failureCode: "turn_plan_superseded_after_delivery_call_started",
          failureReason:
            "The provider call may have started before TurnPlan supersession; automatic resend is disabled.",
        },
      });
      await tx.message.updateMany({
        where: {
          id: { in: uncertainDeliveries.map((attempt) => attempt.messageId) },
          deliveryStatus: { in: ["QUEUED", "PROCESSING", "FAILED"] },
        },
        data: {
          deliveryStatus: "FAILED",
          failureCode: "turn_plan_delivery_reconciliation_required",
          failureReason:
            "Provider outcome is unknown after TurnPlan supersession; automatic resend is disabled.",
        },
      });
      const uncertainOutboxIds = uncertainDeliveries.flatMap((attempt) =>
        attempt.deliveryOutboxId ? [attempt.deliveryOutboxId] : []);
      if (uncertainOutboxIds.length) {
        await tx.outboxEvent.updateMany({
          where: {
            id: { in: uncertainOutboxIds },
            status: { in: ["PENDING", "PROCESSING", "FAILED"] },
          },
          data: {
            status: "DEAD_LETTER",
            processedAt: now,
            lastError: "turn_plan_delivery_reconciliation_required",
          },
        });
      }
    }
    if (acceptedDeliveries.length) {
      await tx.message.updateMany({
        where: {
          id: { in: acceptedDeliveries.map((attempt) => attempt.messageId) },
          deliveryStatus: { in: ["QUEUED", "PROCESSING", "FAILED", "SENT"] },
        },
        data: {
          deliveryStatus: "SENT",
          failureCode: null,
          failureReason: null,
        },
      });
      const acceptedOutboxIds = acceptedDeliveries.flatMap((attempt) =>
        attempt.deliveryOutboxId ? [attempt.deliveryOutboxId] : []);
      if (acceptedOutboxIds.length) {
        await tx.outboxEvent.updateMany({
          where: {
            id: { in: acceptedOutboxIds },
            status: { in: ["PENDING", "PROCESSING", "FAILED"] },
          },
          data: {
            status: "PROCESSED",
            processedAt: now,
            lastError: "turn_plan_superseded_after_provider_acceptance",
          },
        });
      }
    }
    if (
      undeliveredPlanResult?.generationRun?.status === "COMPLETED"
      && undeliveredPlanResult.generationRun.outputMessageId
    ) {
      await tx.message.updateMany({
        where: {
          id: undeliveredPlanResult.generationRun.outputMessageId,
          deliveryStatus: { in: ["QUEUED", "PROCESSING", "FAILED"] },
          externalMessageId: null,
        },
        data: {
          deliveryStatus: "CANCELED",
          failureCode: "turn_plan_superseded_before_delivery",
          failureReason:
            "The result was ready but its TurnPlan revision was superseded before delivery admission.",
        },
      });
      await tx.outboxEvent.updateMany({
        where: {
          aggregateType: "generation_run",
          aggregateId: undeliveredPlanResult.generationRun.id,
          eventType: "generation.requested",
          status: { in: ["PENDING", "PROCESSING", "FAILED"] },
        },
        data: {
          status: "DEAD_LETTER",
          processedAt: now,
          lastError: "turn_plan_superseded_before_delivery",
        },
      });
    }
  }
  await tx.billableUnit.updateMany({
    where: {
      planId,
      status: { in: ["PENDING_RESERVATION", "RESERVED", "TRANSFERRED"] },
    },
    data: { status: "RELEASED", releasedAt: now },
  });
  const workflows = await tx.workflowRun.findMany({
    where: {
      turnPlanId: planId,
      status: { in: ["QUEUED", "RUNNING"] },
    },
    select: { id: true, engine: true },
  });
  for (const workflow of workflows) {
    await tx.workflowRun.update({
      where: { id: workflow.id },
      data: {
        status: "CANCELED",
        enginePhase: workflow.engine === "TEMPORAL" ? "CANCEL_REQUESTED" : "CANCELED",
        cancelRequestedAt: now,
      },
    });
    if (workflow.engine === "TEMPORAL") {
      await tx.workflowCommandOutbox.create({
        data: {
          workflowRunId: workflow.id,
          commandType: "CANCEL",
          payload: { source: "turn_plan_superseded", requestedAt: now.toISOString() },
        },
      });
    }
  }
}

export async function loadReplayableConversationTurnPlan(input: {
  generationRunId: string;
  inputMessageId: string;
}) {
  return prisma.conversationTurnPlan.findFirst({
    where: {
      generationRunId: input.generationRunId,
      inputMessageId: input.inputMessageId,
      protocolVersion: 2,
      status: {
        in: [
          ConversationTurnPlanStatus.VALIDATED,
          ConversationTurnPlanStatus.EXECUTING,
          ConversationTurnPlanStatus.COMPLETED,
        ],
      },
    },
    orderBy: { revision: "desc" },
    include: { actions: { orderBy: { sequence: "asc" } } },
  });
}

export async function loadReplayableConversationTurnPlanV3(input: {
  generationRunId: string;
  inputMessageId: string;
}) {
  return prisma.conversationTurnPlan.findFirst({
    where: {
      generationRunId: input.generationRunId,
      inputMessageId: input.inputMessageId,
      protocolVersion: 3,
      shadowMode: false,
      status: {
        in: [
          ConversationTurnPlanStatus.VALIDATED,
          ConversationTurnPlanStatus.EXECUTING,
          ConversationTurnPlanStatus.COMPLETED,
        ],
      },
    },
    orderBy: { revision: "desc" },
    include: { actions: { orderBy: { sequence: "asc" } } },
  });
}

export async function loadLatestConversationTurnPlanRevision(input: {
  conversationId: string;
  inputMessageId: string;
}) {
  return prisma.conversationTurnPlan.findFirst({
    where: {
      conversationId: input.conversationId,
      inputMessageId: input.inputMessageId,
    },
    orderBy: { revision: "desc" },
    select: { revision: true, status: true },
  });
}

export async function persistConversationTurnPlannerFailure(input: {
  planId: string;
  representativeId: string;
  representativeVersionId?: string | null;
  conversationId: string;
  generationRunId?: string | null;
  inputMessageId: string;
  envelope: TurnEnvelope;
  catalog: CapabilityCatalog;
  plannerProvider?: string;
  plannerModel?: string;
  promptVersion: string;
  code: string;
  reason: string;
  issues?: unknown;
  shadowMode: boolean;
  generationWorkLease?: {
    outboxId: string;
    leaseAttempt: number;
  };
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))
    `;
    await assertTurnPlanContextInTransaction(tx, input);
    const existing = await tx.conversationTurnPlan.findUnique({
      where: { id: input.planId },
    });
    if (existing) return existing;
    const latest = await tx.conversationTurnPlan.findFirst({
      where: {
        conversationId: input.conversationId,
        inputMessageId: input.inputMessageId,
      },
      orderBy: { revision: "desc" },
    });
    const now = new Date();
    const failure = {
      code: input.code,
      reason: input.reason,
      issues: input.issues ?? null,
    };
    return tx.conversationTurnPlan.create({
      data: {
        id: input.planId,
        representativeId: input.representativeId,
        representativeVersionId: input.representativeVersionId ?? null,
        conversationId: input.conversationId,
        generationRunId: input.generationRunId ?? null,
        inputMessageId: input.inputMessageId,
        supersedesPlanId: latest?.id ?? null,
        schemaVersion: "turn-plan.v2",
        promptVersion: input.promptVersion,
        capabilityCatalogHash: stripSha256Prefix(input.catalog.catalogHash),
        planHash: hashCanonical(failure),
        revision: (latest?.revision ?? 0) + 1,
        status: ConversationTurnPlanStatus.FAILED,
        mode: "planner_failure",
        objective: input.envelope.currentMessage.text.slice(0, 2_000),
        language: input.envelope.currentMessage.language,
        requestHash: hashCanonical({
          currentMessage: input.envelope.currentMessage,
          attachments: input.envelope.attachments,
        }),
        plannerProvider: input.plannerProvider ?? null,
        plannerModel: input.plannerModel ?? null,
        planSnapshot: failure as Prisma.InputJsonObject,
        validationResult: failure as Prisma.InputJsonObject,
        shadowMode: input.shadowMode,
        failedAt: now,
      },
    });
  });
}

export async function persistConversationTurnPlanInTransaction(
  tx: Prisma.TransactionClient,
  input: PersistConversationTurnPlanInput,
) {
  await assertTurnPlanContextInTransaction(tx, input);
  const planHash = hashCanonical(input.plan);
  const requestHash = hashCanonical({
    currentMessage: input.envelope.currentMessage,
    attachments: input.envelope.attachments.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    })),
  });
  const existingById = await tx.conversationTurnPlan.findUnique({
    where: { id: input.plan.planId },
    include: { actions: { orderBy: { sequence: "asc" } } },
  });
  if (existingById) {
    if (
      existingById.conversationId !== input.conversationId
      || existingById.inputMessageId !== input.inputMessageId
      || existingById.planHash !== planHash
    ) {
      throw new Error("Turn plan id already belongs to a different immutable plan.");
    }
    return existingById;
  }

  const latest = await tx.conversationTurnPlan.findFirst({
    where: {
      conversationId: input.conversationId,
      inputMessageId: input.inputMessageId,
    },
    orderBy: { revision: "desc" },
    include: { actions: { orderBy: { sequence: "asc" } } },
  });
  if (latest?.planHash === planHash && latest.requestHash === requestHash) {
    return latest;
  }
  if (latest && !isTerminalPlanStatus(latest.status)) {
    await tx.conversationTurnPlan.update({
      where: { id: latest.id },
      data: { status: ConversationTurnPlanStatus.SUPERSEDED },
    });
  }

  const descriptors = new Map(
    input.catalog.capabilities.map((descriptor) => [
      `${descriptor.key}@${descriptor.version}`,
      descriptor,
    ]),
  );
  const actionIds = new Map(
    input.plan.actions.map((action) => [
      action.id,
      deterministicPlanActionId(input.plan.planId, action.id),
    ]),
  );
  const revision = (latest?.revision ?? 0) + 1;
  const now = new Date();
  return tx.conversationTurnPlan.create({
    data: {
      id: input.plan.planId,
      representativeId: input.representativeId,
      representativeVersionId: input.representativeVersionId ?? null,
      conversationId: input.conversationId,
      generationRunId: input.generationRunId ?? null,
      inputMessageId: input.inputMessageId,
      delegationTaskId: input.delegationTaskId ?? null,
      supersedesPlanId: latest?.id ?? null,
      schemaVersion: "turn-plan.v2",
      promptVersion: input.promptVersion,
      capabilityCatalogHash: stripSha256Prefix(input.catalog.catalogHash),
      planHash,
      revision,
      status: ConversationTurnPlanStatus.VALIDATED,
      mode: input.plan.mode,
      objective: input.plan.objective,
      language: input.envelope.currentMessage.language,
      requestHash,
      plannerProvider: input.plannerProvider,
      plannerModel: input.plannerModel,
      planSnapshot: input.plan as unknown as Prisma.InputJsonValue,
      completionCriteria: input.plan.deliverables as unknown as Prisma.InputJsonValue,
      validationResult: {
        ok: true,
        validatedAt: now.toISOString(),
      },
      shadowMode: input.shadowMode,
      validatedAt: now,
      actions: {
        create: input.plan.actions.map((action, index) => {
          const descriptor = descriptors.get(
            `${action.capability.key}@${action.capability.version}`,
          );
          if (!descriptor) {
            throw new Error(
              `Validated turn plan lost capability ${action.capability.key}@${action.capability.version}.`,
            );
          }
          return serializePlanAction({
            planId: input.plan.planId,
            action,
            descriptor,
            sequence: index + 1,
            actionIds,
          });
        }),
      },
    },
    include: { actions: { orderBy: { sequence: "asc" } } },
  });
}

export async function recordConversationPlanActionAuthorization(input: {
  planActionId: string;
  phase: "initial" | "post_approval" | "pre_execution";
  decision: "allow" | "ask" | "deny";
  reason: string;
  policySnapshot?: Record<string, unknown>;
  matchedRuleId?: string;
  validUntil?: Date;
  policyVersion?: string;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.planActionId}))
    `;
    return recordConversationPlanActionAuthorizationInTransaction(tx, input);
  });
}

export async function recordConversationPlanActionAuthorizationInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    planActionId: string;
    phase: "initial" | "post_approval" | "pre_execution";
    decision: "allow" | "ask" | "deny";
    reason: string;
    policySnapshot?: Record<string, unknown>;
    matchedRuleId?: string;
    validUntil?: Date;
    policyVersion?: string;
  },
) {
    const action = await tx.conversationPlanAction.findUnique({
      where: { id: input.planActionId },
      select: {
        id: true,
        argumentsHash: true,
        status: true,
        authorizationPhase: true,
        effectiveDecision: true,
        authorizationVersion: true,
      },
    });
    if (!action) throw new Error("Conversation plan action not found.");
    const latest = await tx.actionAuthorizationDecision.findFirst({
      where: { planActionId: input.planActionId },
      orderBy: { sequence: "desc" },
      select: { sequence: true, phase: true, decision: true },
    });
    const phase = mapAuthorizationPhase(input.phase);
    if (
      latest
      && authorizationPhaseRank(phase) < authorizationPhaseRank(latest.phase)
    ) {
      throw new Error(
        "Authorization phase cannot move backwards after a later execution check.",
      );
    }
    const requestedDecision = mapPolicyDecision(input.decision);
    // Phase order is monotonic. Within one phase a stale allow cannot loosen
    // ask/deny. A later POST_APPROVAL phase may, however, satisfy an earlier
    // ASK. A DENY remains terminal and can never be revived by approval.
    const effectiveDecision =
      action.effectiveDecision === PolicyDecision.DENY
        ? PolicyDecision.DENY
        : latest?.phase === phase
          ? stricterPolicyDecision(latest.decision, requestedDecision)
          : requestedDecision;
    const decision = await tx.actionAuthorizationDecision.create({
      data: {
        planActionId: input.planActionId,
        sequence: (latest?.sequence ?? 0) + 1,
        phase,
        decision: effectiveDecision,
        reason: input.reason,
        ...(input.policySnapshot
          ? {
              policySnapshot:
                input.policySnapshot as Prisma.InputJsonObject,
            }
          : {}),
        policySnapshotHash: input.policySnapshot
          ? hashCanonical(input.policySnapshot)
          : null,
        requestPayloadHash: action.argumentsHash,
        matchedRuleId: input.matchedRuleId ?? null,
        validUntil: input.validUntil ?? null,
      },
    });
    const terminalActionStatuses = new Set<ConversationPlanActionStatus>([
      ConversationPlanActionStatus.EXECUTING,
      ConversationPlanActionStatus.VERIFYING,
      ConversationPlanActionStatus.SUCCEEDED,
      ConversationPlanActionStatus.SKIPPED,
      ConversationPlanActionStatus.FAILED,
      ConversationPlanActionStatus.CANCELED,
      ConversationPlanActionStatus.RECONCILIATION_REQUIRED,
    ]);
    const projection = await tx.conversationPlanAction.updateMany({
      where: {
        id: input.planActionId,
        authorizationVersion: action.authorizationVersion ?? 0,
      },
      data: {
        authorizationPhase: phase,
        effectiveDecision,
        authorizationVersion: { increment: 1 },
        authorizationPolicyVersion: input.policyVersion ?? null,
      },
    });
    if (projection.count !== 1) {
      throw new Error("Authorization projection changed during policy evaluation.");
    }
    if (!terminalActionStatuses.has(action.status)) {
      await tx.conversationPlanAction.update({
        where: { id: input.planActionId },
        data: {
          status: effectiveDecision === PolicyDecision.ALLOW
            ? ConversationPlanActionStatus.READY
            : effectiveDecision === PolicyDecision.ASK
              ? ConversationPlanActionStatus.WAITING_APPROVAL
              : ConversationPlanActionStatus.FAILED,
        },
      });
    }
    return decision;
}

export async function completeConversationTurnPlan(input: {
  planId: string;
  output?: Record<string, unknown>;
}) {
  const completedAt = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.planId}))
    `;
    const plan = await tx.conversationTurnPlan.findUnique({
      where: { id: input.planId },
      include: {
        actions: {
          orderBy: { sequence: "asc" },
          select: {
            id: true,
            actionKey: true,
            capabilityKey: true,
            status: true,
            authorizationVersion: true,
            expectedOutput: true,
            expectedOutputSchema: true,
            actionResults: {
              orderBy: { verifiedAt: "desc" },
              take: 1,
              select: {
                id: true,
                transportOutcome: true,
                semanticOutcome: true,
                evidenceBindings: true,
              },
            },
          },
        },
      },
    });
    if (!plan) return false;
    if (plan.status === ConversationTurnPlanStatus.COMPLETED) return true;
    if (
      plan.status !== ConversationTurnPlanStatus.VALIDATED
      && plan.status !== ConversationTurnPlanStatus.EXECUTING
    ) {
      return false;
    }
    const parsedV3Plan = plan.protocolVersion === 3
      ? turnPlanV3Schema.parse(plan.planSnapshot)
      : null;
    const statusByActionKey = new Map(
      plan.actions.map((action) => [action.actionKey, action.status] as const),
    );
    const recoveredFailedActionKeys = new Set(
      parsedV3Plan?.actions.flatMap((action) =>
        action.failurePolicy.strategy === "try_planned_alternatives"
        && action.failurePolicy.alternativeActionIds.some((alternativeId) =>
          statusByActionKey.get(alternativeId)
            === ConversationPlanActionStatus.SUCCEEDED)
          ? [action.id]
          : []) ?? [],
    );
    const incompleteAction = plan.actions.find((action) =>
      action.status !== ConversationPlanActionStatus.SUCCEEDED
      && !(
        plan.protocolVersion === 3
        && action.status === ConversationPlanActionStatus.SKIPPED
      )
      && !(
        plan.protocolVersion === 3
        && action.status === ConversationPlanActionStatus.FAILED
        && recoveredFailedActionKeys.has(action.actionKey)
      ));
    if (incompleteAction) {
      throw new Error(
        `Turn plan cannot complete before action ${incompleteAction.id} succeeds.`,
      );
    }
    let goalOutcomes: ReturnType<typeof resolveGoalOutcomesV3> | null = null;
    if (parsedV3Plan) {
      const satisfiedDeliverableIds = parsedV3Plan.deliverables
        .filter((deliverable) =>
          deliverable.producedByActionIds.length > 0
          && deliverable.producedByActionIds.every((actionId) => {
            const status = statusByActionKey.get(actionId);
            return status === ConversationPlanActionStatus.SUCCEEDED
              || status === ConversationPlanActionStatus.SKIPPED;
          }))
        .map((deliverable) => deliverable.id);
      goalOutcomes = resolveGoalOutcomesV3({
        plan: parsedV3Plan,
        executionEpoch: plan.executionEpoch,
        stateVersion: Math.max(
          0,
          ...plan.actions.map((action) => action.authorizationVersion),
        ),
        actionOutcomes: plan.actions.map((action) => ({
          actionId: action.actionKey,
          status: action.status === ConversationPlanActionStatus.SUCCEEDED
            ? "succeeded" as const
            : action.status === ConversationPlanActionStatus.SKIPPED
              ? "skipped" as const
              : "failed" as const,
        })),
        satisfiedDeliverableIds,
      });
      const unsatisfiedGoal = goalOutcomes.find((goal) =>
        goal.status !== "succeeded");
      if (unsatisfiedGoal) {
        throw new Error(
          `Turn plan cannot complete while goal ${unsatisfiedGoal.goalId} is ${unsatisfiedGoal.status}.`,
        );
      }
      validatePersistedComposerResultV3({
        parsedPlan: parsedV3Plan,
        persistedActions: plan.actions,
        goalOutcomes,
      });
    }
    for (const action of plan.actions) {
      if (
        action.status === ConversationPlanActionStatus.SKIPPED
        || recoveredFailedActionKeys.has(action.actionKey)
      ) continue;
      const problems = validatePersistedActionOutput(
        action.expectedOutput,
        action.expectedOutputSchema,
        `/actions/${action.id}/output`,
      );
      if (problems.length) {
        throw new Error(
          `Turn plan action ${action.id} output failed validation: ${problems.join("; ")}`,
        );
      }
    }
    const completed = await tx.conversationTurnPlan.updateMany({
      where: {
        id: input.planId,
        status: {
          in: [
            ConversationTurnPlanStatus.VALIDATED,
            ConversationTurnPlanStatus.EXECUTING,
          ],
        },
      },
      data: {
        status: ConversationTurnPlanStatus.COMPLETED,
        startedAt: plan.startedAt ?? completedAt,
        completedAt,
        validationResult: {
          ok: true,
          completedAt: completedAt.toISOString(),
          output: input.output ?? null,
          goalOutcomes,
        } as Prisma.InputJsonObject,
      },
    });
    return completed.count === 1;
  });
}

function validatePersistedComposerResultV3(input: {
  parsedPlan: TurnPlanV3;
  persistedActions: Array<{
    actionKey: string;
    capabilityKey: string;
    expectedOutput: unknown;
    actionResults: Array<{
      id: string;
      transportOutcome: string;
      semanticOutcome: string;
      evidenceBindings: unknown;
    }>;
  }>;
  goalOutcomes: ReturnType<typeof resolveGoalOutcomesV3>;
}) {
  const composerPlanAction = input.parsedPlan.actions.find((action) =>
    action.capability.key === "response.compose");
  if (!composerPlanAction) {
    throw new Error("V3 completed Plan is missing response.compose.");
  }
  const composer = input.persistedActions.find((action) =>
    action.actionKey === composerPlanAction.id
    && action.capabilityKey === "response.compose");
  const composerResult = composer?.actionResults[0];
  if (!composer || !composerResult || composerResult.semanticOutcome !== "succeeded") {
    throw new Error("V3 completed Plan is missing a successful Composer ActionResult.");
  }
  const actionResults = input.persistedActions.flatMap((action) => {
    const result = action.actionResults[0];
    return result
      ? [{
          actionId: action.actionKey,
          actionResultId: result.id,
          transportOutcome: result.transportOutcome,
          semanticOutcome: result.semanticOutcome,
        }]
      : [];
  });
  const evidence = readPersistedComposerEvidenceBindingsV3(
    composerResult.evidenceBindings,
  );
  const knowledgeFallbacks: KnowledgeFallbackActivationV3[] =
    input.parsedPlan.goals.flatMap((goal) => {
    if (
      goal.evidenceFallbackPolicy?.kind
        !== "authorized_knowledge_miss_to_stable_general"
    ) return [];
    for (const actionId of goal.actionIds) {
      const plannedAction = input.parsedPlan.actions.find((action) =>
        action.id === actionId
        && action.capability.key === "knowledge.retrieve_authorized");
      if (!plannedAction) continue;
      const persisted = input.persistedActions.find((action) =>
        action.actionKey === plannedAction.id);
      const status = asV3Record(persisted?.expectedOutput)?.["status"];
      if (status === "not_found" || status === "unavailable") {
        return [{ goalId: goal.id, status }];
      }
    }
    return [];
    });
  const validated = validateComposedMessageDraftV3({
    draft: composer.expectedOutput,
    plan: input.parsedPlan,
    evidence,
    actionResults,
    goalOutcomes: input.goalOutcomes,
    ...(knowledgeFallbacks.length ? { knowledgeFallbacks } : {}),
  });
  if (!validated.ok) {
    throw new Error(
      `V3 Composer ActionResult failed final evidence validation: ${validated.issues
        .slice(0, 8)
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
}

function readPersistedComposerEvidenceBindingsV3(
  value: unknown,
): ComposerEvidenceReferenceV3[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asV3Record(item);
    const evidenceId = record?.["evidenceId"];
    const evidenceClass = record?.["evidenceClass"];
    if (
      typeof evidenceId !== "string"
      || (
        evidenceClass !== "authorized_knowledge"
        && evidenceClass !== "tool_output"
        && evidenceClass !== "transactional_authority"
        && evidenceClass !== "stable_general"
      )
    ) return [];
    return [{
      evidenceId,
      evidenceClass,
      ...(typeof record?.["sourceActionId"] === "string"
        ? { sourceActionId: record["sourceActionId"] }
        : {}),
      ...(typeof record?.["actionResultId"] === "string"
        ? { actionResultId: record["actionResultId"] }
        : {}),
      ...(Array.isArray(record?.["goalIds"])
        ? {
            goalIds: record["goalIds"].filter((entry): entry is string =>
              typeof entry === "string"),
          }
        : {}),
      ...(Array.isArray(record?.["sourceKinds"])
        ? {
            sourceKinds: record["sourceKinds"].filter((entry): entry is string =>
              typeof entry === "string"),
          }
        : {}),
    }];
  });
}

function asV3Record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function terminalizeV3ActionAdmission(input: {
  executionId: string;
  outcome: "rejected" | "expired" | "policy_denied" | "invalid";
  reason: string;
}) {
  return prisma.$transaction((tx) =>
    terminalizeV3ActionAdmissionInTransaction(tx, input));
}

export async function terminalizeV3ActionAdmissionInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    executionId: string;
    outcome: "rejected" | "expired" | "policy_denied" | "invalid";
    reason: string;
  },
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${input.executionId}))
  `;
  const execution = await tx.toolExecution.findUnique({
    where: { id: input.executionId },
    include: {
      planAction: {
        include: { turnPlan: { include: { activeExecutionFence: true } } },
      },
    },
  });
  if (!execution?.planAction) return execution;
  const action = execution.planAction;
  const plan = action.turnPlan;
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${plan.scopeKey ?? plan.id}))
  `;
  const fence = plan.activeExecutionFence;
  if (
    plan.protocolVersion !== 3
    || plan.shadowMode
    || !fence
    || fence.activePlanId !== plan.id
    || fence.activeRevision !== plan.revision
    || fence.executionEpoch !== plan.executionEpoch
    || execution.planRevision !== plan.revision
    || execution.executionEpoch !== plan.executionEpoch
  ) {
    throw new Error("V3 action admission lost its active Plan fence.");
  }
  if (
    ["SUCCEEDED", "FAILED", "CANCELED"].includes(execution.status)
    && ["SUCCEEDED", "FAILED", "CANCELED", "RECONCILIATION_REQUIRED"]
      .includes(action.status)
  ) {
    return execution;
  }
  if (
    ["CALL_STARTED", "RESPONSE_RECEIVED", "VERIFYING", "OUTCOME_UNKNOWN"]
      .includes(execution.attemptPhase ?? "")
    && execution.status !== "CANCELED"
  ) {
    const now = new Date();
    await tx.toolExecution.updateMany({
      where: {
        id: execution.id,
        status: { in: ["QUEUED", "RUNNING", "BLOCKED"] },
        attemptPhase: {
          in: ["CALL_STARTED", "RESPONSE_RECEIVED", "VERIFYING", "OUTCOME_UNKNOWN"],
        },
      },
      data: {
        status: "FAILED",
        attemptPhase: "OUTCOME_UNKNOWN",
        transportOutcome: "outcome_unknown",
        semanticOutcome: "unknown",
        executionLeaseToken: null,
        finishedAt: now,
      },
    });
    await tx.conversationPlanAction.updateMany({
      where: { id: action.id },
      data: { status: "RECONCILIATION_REQUIRED" },
    });
    await tx.delegationTaskExternalEffect.updateMany({
      where: { planActionId: action.id },
      data: {
        status: "RECONCILIATION_REQUIRED",
        failureReason: input.reason.slice(0, 1_000),
      },
    });
    await tx.billableUnit.updateMany({
      where: {
        actionId: action.id,
        status: { in: ["RESERVED", "TRANSFERRED", "SETTLEMENT_PENDING"] },
      },
      data: {
        status: "HELD_FOR_RECONCILIATION",
        reconciliationHeldAt: now,
      },
    });
    if (execution.executionOutboxId) {
      await tx.outboxEvent.updateMany({
        where: {
          id: execution.executionOutboxId,
          eventType: "action.execution.requested",
          status: { in: ["PENDING", "PROCESSING", "FAILED"] },
        },
        data: {
          status: "PROCESSED",
          processedAt: now,
          lastError: "action_execution_outcome_unknown",
        },
      });
    }
    return tx.toolExecution.findUnique({ where: { id: execution.id } });
  }

  const now = new Date();
  const actionStatus = input.outcome === "rejected" || input.outcome === "expired"
    ? "CANCELED" as const
    : "FAILED" as const;
  await tx.toolExecution.updateMany({
    where: {
      id: execution.id,
      status: { in: ["BLOCKED", "QUEUED", "RUNNING"] },
    },
    data: {
      status: actionStatus === "CANCELED" ? "CANCELED" : "FAILED",
      attemptPhase: "CANCELED_BEFORE_START",
      transportOutcome: "confirmed_not_sent",
      semanticOutcome: "failed",
      executionLeaseToken: null,
      finishedAt: now,
    },
  });
  await tx.conversationPlanAction.updateMany({
    where: {
      id: action.id,
      status: {
        in: ["PLANNED", "AUTHORIZING", "WAITING_APPROVAL", "READY", "QUEUED", "EXECUTING"],
      },
    },
    data: {
      status: actionStatus,
      ...(actionStatus === "FAILED" ? { failedAt: now } : { completedAt: now }),
    },
  });
  if (execution.executionOutboxId) {
    await tx.outboxEvent.updateMany({
      where: {
        id: execution.executionOutboxId,
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: {
        status: "DEAD_LETTER",
        processedAt: now,
        lastError: input.reason.slice(0, 2_000),
      },
    });
  }
  await tx.delegationTaskExternalEffect.updateMany({
    where: {
      planActionId: action.id,
      status: { in: ["PROPOSED", "WAITING_APPROVAL", "APPROVED"] },
    },
    data: {
      status: actionStatus === "CANCELED" ? "CANCELED" : "FAILED",
      failureReason: input.reason.slice(0, 1_000),
    },
  });
  await tx.billableUnit.updateMany({
    where: {
      actionId: action.id,
      status: { in: ["PENDING_RESERVATION", "RESERVED", "TRANSFERRED"] },
    },
    data: { status: "RELEASED", releasedAt: now },
  });
  await tx.conversationPlanAction.updateMany({
    where: {
      turnPlanId: plan.id,
      id: { not: action.id },
      status: { in: ["PLANNED", "AUTHORIZING", "WAITING_APPROVAL", "READY", "QUEUED"] },
    },
    data: { status: "CANCELED", completedAt: now },
  });
  await tx.conversationTurnPlan.updateMany({
    where: {
      id: plan.id,
      status: { in: ["PROPOSED", "VALIDATED", "EXECUTING"] },
    },
    data: {
      status: actionStatus === "CANCELED" ? "CANCELED" : "FAILED",
      ...(actionStatus === "FAILED" ? { failedAt: now } : { completedAt: now }),
      validationResult: {
        ok: false,
        outcome: input.outcome,
        reason: input.reason.slice(0, 2_000),
        actionId: action.id,
        terminalAt: now.toISOString(),
      },
    },
  });
  return tx.toolExecution.findUnique({ where: { id: execution.id } });
}

export async function completeReadyConversationTurnPlanForGenerationRun(
  generationRunId: string,
) {
  const plan = await prisma.conversationTurnPlan.findFirst({
    where: {
      generationRunId,
      shadowMode: false,
      status: ConversationTurnPlanStatus.EXECUTING,
    },
    orderBy: { revision: "desc" },
    select: { id: true },
  });
  if (!plan) return false;
  return completeConversationTurnPlan({ planId: plan.id });
}

export async function failConversationTurnPlan(input: {
  planId: string;
  reason: string;
  actionId?: string;
}) {
  const failedAt = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.planId}))
    `;
    const reconciliationAction =
      await tx.conversationPlanAction.findFirst({
        where: {
          turnPlanId: input.planId,
          status: ConversationPlanActionStatus.RECONCILIATION_REQUIRED,
        },
        select: { id: true },
      });
    if (input.actionId) {
      await tx.conversationPlanAction.updateMany({
        where: {
          id: input.actionId,
          turnPlanId: input.planId,
          status: {
            notIn: [
              ConversationPlanActionStatus.SUCCEEDED,
              ConversationPlanActionStatus.SKIPPED,
              ConversationPlanActionStatus.RECONCILIATION_REQUIRED,
            ],
          },
        },
        data: {
          status: ConversationPlanActionStatus.FAILED,
          failedAt,
        },
      });
    }
    await tx.conversationPlanAction.updateMany({
      where: {
        turnPlanId: input.planId,
        status: {
          notIn: [
            ConversationPlanActionStatus.SUCCEEDED,
            ConversationPlanActionStatus.SKIPPED,
            ConversationPlanActionStatus.FAILED,
            ConversationPlanActionStatus.CANCELED,
            ConversationPlanActionStatus.RECONCILIATION_REQUIRED,
          ],
        },
      },
      data: {
        status: ConversationPlanActionStatus.CANCELED,
        completedAt: failedAt,
      },
    });
    if (reconciliationAction) {
      const waiting = await tx.conversationTurnPlan.updateMany({
        where: {
          id: input.planId,
          status: {
            notIn: [
              ConversationTurnPlanStatus.COMPLETED,
              ConversationTurnPlanStatus.CANCELED,
              ConversationTurnPlanStatus.SUPERSEDED,
            ],
          },
        },
        data: {
          status: ConversationTurnPlanStatus.EXECUTING,
          failedAt: null,
          validationResult: {
            ok: false,
            reconciliationRequired: true,
            reason: input.reason.slice(0, 2_000),
            observedAt: failedAt.toISOString(),
          },
        },
      });
      return waiting.count === 1;
    }
    const failed = await tx.conversationTurnPlan.updateMany({
      where: {
        id: input.planId,
        status: {
          notIn: [
            ConversationTurnPlanStatus.COMPLETED,
            ConversationTurnPlanStatus.CANCELED,
            ConversationTurnPlanStatus.SUPERSEDED,
          ],
        },
      },
      data: {
        status: ConversationTurnPlanStatus.FAILED,
        failedAt,
        validationResult: {
          ok: false,
          reason: input.reason.slice(0, 2_000),
          failedAt: failedAt.toISOString(),
        },
      },
    });
    return failed.count === 1;
  });
}

function serializePlanAction(input: {
  planId: string;
  action: PlanAction;
  descriptor: CapabilityDescriptor;
  sequence: number;
  actionIds: Map<string, string>;
}) {
  const argumentsHash = hashCanonical(input.action.arguments);
  return {
    id: input.actionIds.get(input.action.id)!,
    sequence: input.sequence,
    actionKey: input.action.id,
    kind: mapActionKind(input.descriptor),
    capability: mapLegacyCapability(input.descriptor.key),
    capabilityKey: input.descriptor.key,
    capabilityVersion: input.descriptor.version,
    capabilityDefinitionHash: stripSha256Prefix(
      input.descriptor.definitionHash,
    ),
    sideEffectClass: mapSideEffect(input.descriptor.effect),
    status: ConversationPlanActionStatus.PLANNED,
    arguments: input.action.arguments as Prisma.InputJsonObject,
    argumentsHash,
    argumentProvenance:
      input.action.argumentProvenance as unknown as Prisma.InputJsonObject,
    inputSnapshot: {
      capability: input.action.capability,
      arguments: input.action.arguments,
      argumentProvenance: input.action.argumentProvenance,
    } as unknown as Prisma.InputJsonObject,
    expectedOutputSchema:
      input.action.expectedOutputSchema as Prisma.InputJsonObject,
    expectedOutput: input.action.expectedOutputSchema as Prisma.InputJsonObject,
    completionCriteria:
      input.action.completionCriteria as unknown as Prisma.InputJsonValue,
    onFailure: input.action.onFailure,
    dependsOnActionIds: input.action.dependsOn.map((actionKey) => {
      const actionId = input.actionIds.get(actionKey);
      if (!actionId) throw new Error(`Unknown persisted plan dependency ${actionKey}.`);
      return actionId;
    }),
    idempotencyKey: `turn-plan:${input.planId}:action:${input.action.id}`,
    requestPayloadHash: argumentsHash,
  };
}

function serializePlanActionV3(input: {
  planId: string;
  action: PlanActionV3;
  definition: CapabilityDefinitionV3;
  sequence: number;
  actionIds: Map<string, string>;
}) {
  const argumentsHash = hashCanonical(input.action.arguments);
  const persistedActionId = input.actionIds.get(input.action.id)!;
  const mapActionId = (actionKey: string) => {
    const actionId = input.actionIds.get(actionKey);
    if (!actionId) {
      throw new Error(`Unknown persisted TurnPlan V3 action ${actionKey}.`);
    }
    return actionId;
  };
  const dependencies = input.action.dependencies.map((dependency) => ({
    ...dependency,
    actionId: mapActionId(dependency.actionId),
  }));
  const activation = input.action.activation.mode === "on_failure"
    ? {
        ...input.action.activation,
        sourceActionId: mapActionId(input.action.activation.sourceActionId),
      }
    : input.action.activation;
  const failurePolicy =
    input.action.failurePolicy.strategy === "try_planned_alternatives"
      ? {
          ...input.action.failurePolicy,
          alternativeActionIds:
            input.action.failurePolicy.alternativeActionIds.map(mapActionId),
        }
      : input.action.failurePolicy;
  return {
    id: persistedActionId,
    sequence: input.sequence,
    actionKey: input.action.id,
    kind: mapActionKindV3(input.definition),
    capability: mapLegacyCapability(input.definition.key),
    capabilityKey: input.definition.key,
    capabilityVersion: input.definition.version,
    capabilityDefinitionHash: stripSha256Prefix(input.definition.definitionHash),
    sideEffectClass: mapSideEffectV3(input.definition.effect),
    status: ConversationPlanActionStatus.PLANNED,
    arguments: input.action.arguments as Prisma.InputJsonObject,
    argumentsHash,
    argumentProvenance:
      input.action.argumentProvenance as unknown as Prisma.InputJsonObject,
    inputSnapshot: {
      protocolVersion: 3,
      capability: input.action.capability,
      arguments: input.action.arguments,
      argumentProvenance: input.action.argumentProvenance,
      dependencies: input.action.dependencies,
      activation: input.action.activation,
      failurePolicy: input.action.failurePolicy,
      effect: input.definition.effect,
    } as unknown as Prisma.InputJsonObject,
    expectedOutputSchema:
      input.action.expectedOutputSchema as Prisma.InputJsonObject,
    successContract: input.definition.successContract
      ? input.definition.successContract as unknown as Prisma.InputJsonObject
      : Prisma.JsonNull,
    expectedOutput:
      input.action.expectedOutputSchema as Prisma.InputJsonObject,
    completionCriteria:
      input.action.completionCriteria as unknown as Prisma.InputJsonValue,
    onFailure: input.action.failurePolicy.strategy,
    dependsOnActionIds: dependencies.map((dependency) => dependency.actionId),
    dependencyPolicy: dependencies as unknown as Prisma.InputJsonValue,
    activationPolicy: activation as unknown as Prisma.InputJsonValue,
    failurePolicy: failurePolicy as unknown as Prisma.InputJsonValue,
    idempotencyKey: `turn-plan:${input.planId}:action:${input.action.id}`,
    requestPayloadHash: argumentsHash,
  };
}

function mapActionKindV3(definition: CapabilityDefinitionV3) {
  if (definition.key === "response.compose"
    || definition.executor === "knowledge") {
    return ConversationPlanActionKind.RESPOND;
  }
  if (definition.key === "handoff.request") {
    return ConversationPlanActionKind.HANDOFF;
  }
  if (definition.key.startsWith("material.")
    || definition.key.startsWith("artifact.")) {
    return ConversationPlanActionKind.DELIVER;
  }
  return ConversationPlanActionKind.CAPABILITY;
}

function mapSideEffectV3(effect: CapabilityDefinitionV3["effect"]) {
  if (effect.boundary === "internal") {
    return effect.mutation === "write"
      ? ConversationPlanSideEffectClass.INTERNAL
      : ConversationPlanSideEffectClass.NONE;
  }
  if (effect.mutation === "none") {
    return ConversationPlanSideEffectClass.NONE;
  }
  return effect.reversibility === "reversible"
    ? ConversationPlanSideEffectClass.EXTERNAL_REVERSIBLE
    : ConversationPlanSideEffectClass.EXTERNAL_IRREVERSIBLE;
}

export function buildPlanScopeStorageKeyV3(scope: PlanScopeKeyV3) {
  return `turn-plan-scope:v1:${hashCanonical(scope)}`;
}

function assertPlanScopeMatchesPersistenceContext(
  scope: PlanScopeKeyV3,
  input: Pick<
    PersistConversationTurnPlanV3Input,
    "conversationId" | "inputMessageId" | "delegationTaskId"
  >,
) {
  if (
    scope.kind === "generation_turn"
    && (
      scope.conversationId !== input.conversationId
      || scope.inputMessageId !== input.inputMessageId
    )
  ) {
    throw new Error("TurnPlan V3 generation scope does not match its persistence coordinate.");
  }
  if (
    scope.kind === "delegation_task"
    && scope.delegationTaskId !== (input.delegationTaskId ?? null)
  ) {
    throw new Error("TurnPlan V3 delegation scope does not match its persistence coordinate.");
  }
  if (
    scope.kind === "collector"
    && scope.conversationId !== input.conversationId
  ) {
    throw new Error("TurnPlan V3 collector scope does not match its conversation.");
  }
}

function mapActionKind(descriptor: CapabilityDescriptor) {
  if (descriptor.key === "knowledge.answer_public"
    || descriptor.key === "conversation.status") {
    return ConversationPlanActionKind.RESPOND;
  }
  if (descriptor.key === "handoff.request") {
    return ConversationPlanActionKind.HANDOFF;
  }
  if (descriptor.key === "material.deliver_public"
    || descriptor.key === "artifact.generate_document") {
    return ConversationPlanActionKind.DELIVER;
  }
  return ConversationPlanActionKind.CAPABILITY;
}

function mapSideEffect(effect: CapabilityDescriptor["effect"]) {
  switch (effect) {
    case "internal_write":
      return ConversationPlanSideEffectClass.INTERNAL;
    case "external_reversible":
      return ConversationPlanSideEffectClass.EXTERNAL_REVERSIBLE;
    case "external_irreversible":
      return ConversationPlanSideEffectClass.EXTERNAL_IRREVERSIBLE;
    case "read_only":
    default:
      return ConversationPlanSideEffectClass.NONE;
  }
}

function mapLegacyCapability(key: string) {
  const legacy = key.startsWith("compute.") ? key.slice("compute.".length) : "";
  switch (legacy) {
    case "exec": return "EXEC" as const;
    case "read": return "READ" as const;
    case "write": return "WRITE" as const;
    case "process": return "PROCESS" as const;
    case "browser": return "BROWSER" as const;
    case "mcp": return "MCP" as const;
    default: return null;
  }
}

function mapAuthorizationPhase(phase: "initial" | "post_approval" | "pre_execution") {
  switch (phase) {
    case "post_approval": return ActionAuthorizationPhase.POST_APPROVAL;
    case "pre_execution": return ActionAuthorizationPhase.PRE_EXECUTION;
    case "initial": return ActionAuthorizationPhase.INITIAL;
  }
}

function mapPolicyDecision(decision: "allow" | "ask" | "deny") {
  switch (decision) {
    case "allow": return PolicyDecision.ALLOW;
    case "ask": return PolicyDecision.ASK;
    case "deny": return PolicyDecision.DENY;
  }
}

function authorizationPhaseRank(phase: ActionAuthorizationPhase) {
  switch (phase) {
    case ActionAuthorizationPhase.INITIAL:
      return 0;
    case ActionAuthorizationPhase.POST_APPROVAL:
      return 1;
    case ActionAuthorizationPhase.PRE_EXECUTION:
      return 2;
  }
}

function stricterPolicyDecision(
  left: PolicyDecision,
  right: PolicyDecision,
) {
  const rank: Record<PolicyDecision, number> = {
    [PolicyDecision.ALLOW]: 0,
    [PolicyDecision.ASK]: 1,
    [PolicyDecision.DENY]: 2,
  };
  return rank[left] >= rank[right] ? left : right;
}

async function assertTurnPlanContextInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    representativeId: string;
    representativeVersionId?: string | null;
    conversationId: string;
    generationRunId?: string | null;
    inputMessageId: string;
    delegationTaskId?: string | null;
    envelope: TurnEnvelope;
    generationWorkLease?: {
      outboxId: string;
      leaseAttempt: number;
    };
  },
) {
  if (
    input.envelope.currentMessage.id !== input.inputMessageId
    || input.envelope.representativeVersion.representativeId
      !== input.representativeId
  ) {
    throw new Error("Turn plan envelope does not match its persisted coordinate.");
  }
  const [conversation, message, generationRun, representativeVersion, task] =
    await Promise.all([
      tx.conversation.findUnique({
        where: { id: input.conversationId },
        select: { representativeId: true },
      }),
      tx.message.findUnique({
        where: { id: input.inputMessageId },
        select: { conversationId: true },
      }),
      input.generationRunId
        ? tx.generationRun.findUnique({
            where: { id: input.generationRunId },
            select: {
              conversationId: true,
              inputMessageId: true,
              representativeVersionId: true,
              status: true,
            },
          })
        : Promise.resolve(null),
      input.representativeVersionId
        ? tx.representativeVersion.findUnique({
            where: { id: input.representativeVersionId },
            select: { representativeId: true },
          })
        : Promise.resolve(null),
      input.delegationTaskId
        ? tx.delegationTask.findUnique({
            where: { id: input.delegationTaskId },
            select: {
              representativeId: true,
              originConversationId: true,
            },
          })
        : Promise.resolve(null),
    ]);
  if (
    !conversation
    || conversation.representativeId !== input.representativeId
    || !message
    || message.conversationId !== input.conversationId
  ) {
    throw new Error("Turn plan conversation and input message coordinates do not match.");
  }
  if (
    input.generationRunId
    && (
      !generationRun
      || generationRun.conversationId !== input.conversationId
      || generationRun.inputMessageId !== input.inputMessageId
      || generationRun.representativeVersionId
        !== (input.representativeVersionId ?? null)
      || (
        input.generationWorkLease
        && generationRun.status !== GenerationRunStatus.PROCESSING
      )
    )
  ) {
    throw new Error("Turn plan generation run coordinate does not match.");
  }
  if (input.generationWorkLease) {
    if (!input.generationRunId) {
      throw new Error("Turn plan generation lease requires a generation run.");
    }
    const outbox = await tx.outboxEvent.findUnique({
      where: { id: input.generationWorkLease.outboxId },
      select: {
        aggregateType: true,
        aggregateId: true,
        eventType: true,
        status: true,
        attemptCount: true,
        availableAt: true,
      },
    });
    if (
      !outbox
      || outbox.aggregateType !== "generation_run"
      || outbox.aggregateId !== input.generationRunId
      || outbox.eventType !== "generation.requested"
      || outbox.status !== "PROCESSING"
      || outbox.attemptCount !== input.generationWorkLease.leaseAttempt
      || outbox.availableAt.getTime() <= Date.now()
    ) {
      throw new Error("Turn plan generation work lease was lost.");
    }
  }
  if (
    input.representativeVersionId
    && (
      !representativeVersion
      || representativeVersion.representativeId !== input.representativeId
    )
  ) {
    throw new Error("Turn plan representative version coordinate does not match.");
  }
  if (
    input.delegationTaskId
    && (
      !task
      || task.representativeId !== input.representativeId
      || task.originConversationId !== input.conversationId
    )
  ) {
    throw new Error("Turn plan delegation task coordinate does not match.");
  }
}

function validatePersistedActionOutput(
  value: unknown,
  rawSchema: unknown,
  path: string,
): string[] {
  if (!isJsonObject(rawSchema)) return [`${path} schema is not an object`];
  const schema = rawSchema;
  const problems: string[] = [];
  if (Array.isArray(schema["allOf"])) {
    for (const nested of schema["allOf"]) {
      problems.push(...validatePersistedActionOutput(value, nested, path));
    }
  }
  if (
    Array.isArray(schema["anyOf"])
    && !schema["anyOf"].some(
      (nested) => validatePersistedActionOutput(value, nested, path).length === 0,
    )
  ) {
    problems.push(`${path} does not match any allowed output shape`);
    return problems;
  }
  if (
    Array.isArray(schema["enum"])
    && !schema["enum"].some(
      (candidate) => canonicalJson(candidate) === canonicalJson(value),
    )
  ) {
    problems.push(`${path} is outside the expected enum`);
  }
  if (
    Object.prototype.hasOwnProperty.call(schema, "const")
    && canonicalJson(schema["const"]) !== canonicalJson(value)
  ) {
    problems.push(`${path} does not match the expected constant`);
  }

  const type = schema["type"];
  if (type === "object") {
    if (!isJsonObject(value)) {
      problems.push(`${path} must be an object`);
      return problems;
    }
    const properties = isJsonObject(schema["properties"])
      ? schema["properties"]
      : {};
    const required = Array.isArray(schema["required"])
      ? schema["required"].filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    for (const key of required) {
      if (!(key in value)) problems.push(`${path}/${key} is required`);
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in value)) continue;
      problems.push(
        ...validatePersistedActionOutput(
          value[key],
          propertySchema,
          `${path}/${key}`,
        ),
      );
    }
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          problems.push(`${path}/${key} is not allowed`);
        }
      }
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) {
      problems.push(`${path} must be an array`);
      return problems;
    }
    if (schema["items"] !== undefined) {
      value.forEach((item, index) => {
        problems.push(
          ...validatePersistedActionOutput(
            item,
            schema["items"],
            `${path}/${index}`,
          ),
        );
      });
    }
    if (
      typeof schema["minItems"] === "number"
      && value.length < schema["minItems"]
    ) {
      problems.push(`${path} has fewer items than allowed`);
    }
    if (
      typeof schema["maxItems"] === "number"
      && value.length > schema["maxItems"]
    ) {
      problems.push(`${path} has more items than allowed`);
    }
  } else if (type === "string") {
    if (typeof value !== "string") {
      problems.push(`${path} must be a string`);
      return problems;
    }
    if (
      typeof schema["minLength"] === "number"
      && value.length < schema["minLength"]
    ) {
      problems.push(`${path} is shorter than allowed`);
    }
    if (
      typeof schema["maxLength"] === "number"
      && value.length > schema["maxLength"]
    ) {
      problems.push(`${path} is longer than allowed`);
    }
    if (
      typeof schema["pattern"] === "string"
      && !new RegExp(schema["pattern"]).test(value)
    ) {
      problems.push(`${path} does not match the required pattern`);
    }
  } else if (type === "number" && typeof value !== "number") {
    problems.push(`${path} must be a number`);
  } else if (
    type === "integer"
    && (typeof value !== "number" || !Number.isInteger(value))
  ) {
    problems.push(`${path} must be an integer`);
  } else if (type === "number" || type === "integer") {
    if (
      typeof schema["minimum"] === "number"
      && (value as number) < schema["minimum"]
    ) {
      problems.push(`${path} is below the minimum`);
    }
    if (
      typeof schema["maximum"] === "number"
      && (value as number) > schema["maximum"]
    ) {
      problems.push(`${path} is above the maximum`);
    }
  } else if (type === "boolean" && typeof value !== "boolean") {
    problems.push(`${path} must be a boolean`);
  } else if (type === "null" && value !== null) {
    problems.push(`${path} must be null`);
  }
  return problems;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deterministicPlanActionId(planId: string, actionKey: string) {
  return `cpa_${hashCanonical({ planId, actionKey }).slice(0, 28)}`;
}

function stripSha256Prefix(value: string) {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function hashCanonical(value: unknown) {
  return Array.from(
    sha256Digest(new TextEncoder().encode(canonicalJson(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

function isTerminalPlanStatus(status: ConversationTurnPlanStatus) {
  return status === ConversationTurnPlanStatus.COMPLETED
    || status === ConversationTurnPlanStatus.FAILED
    || status === ConversationTurnPlanStatus.CANCELED
    || status === ConversationTurnPlanStatus.SUPERSEDED;
}
