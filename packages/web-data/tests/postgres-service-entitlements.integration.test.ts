import {
  AudienceIdentityStatus,
  Channel,
  ConversationEpisodeStatus,
  GenerationRunStatus,
  MessageDeliveryStatus,
  MessageSenderType,
  PaymentProvider,
  RechargeOrderStatus,
  ReliableEventStatus,
  ServiceEntitlementLedgerKind,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assignConversationOperator,
  completeInlineGenerationRun,
  ConversationAiDeliveryControlError,
  ConversationWorkInFlightControlError,
  editConversationMessage,
  GenerationWorkLeaseLostError,
  markGenerationDeliveryComplete,
  prepareGenerationMessageChannelDelivery,
} from "../src/conversation-platform";
import { prisma } from "../src/prisma";
import {
  consumeConversationEntitlement,
  createServicePaymentOrder,
  fulfillServicePaymentOrder,
  grantServiceEntitlement,
  refundServiceEntitlement,
  releaseConversationEntitlement,
  releaseConversationEntitlementByGenerationRunId,
  reserveConversationEntitlement,
  type ConversationEntitlementReservation,
  type ServicePaymentEvidenceInput,
} from "../src/service-entitlements";
import { mergeAudienceIdentity } from "../src/web-audience";

const describePostgres =
  process.env.DELEGATE_POSTGRES_E2E === "1" ? describe : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("service entitlement PostgreSQL 16 concurrency", () => {
  beforeAll(async () => {
    const [version] = await prisma.$queryRaw<Array<{ server_version_num: string }>>`
      SELECT current_setting('server_version_num') AS server_version_num
    `;
    const versionNumber = Number(version?.server_version_num);
    if (versionNumber < 160_000 || versionNumber >= 170_000) {
      throw new Error(
        `Service entitlement concurrency E2E requires PostgreSQL 16; received ${version?.server_version_num ?? "unknown"}.`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("does not overspend when two generation runs reserve the same final unit", async () => {
    const fixture = await createFixture();
    try {
      const firstRunId = await createGenerationRun(fixture, "reserve-a");
      const secondRunId = await createGenerationRun(fixture, "reserve-b");
      await grantServiceEntitlement({
        ...fixture.coordinates,
        units: 1,
        operationKey: `${fixture.suffix}:grant:one`,
      });

      const reservations = await Promise.all([
        reserveConversationEntitlement({
          ...fixture.coordinates,
          generationRunId: firstRunId,
          productCodes: [fixture.coordinates.productCode],
        }),
        reserveConversationEntitlement({
          ...fixture.coordinates,
          generationRunId: secondRunId,
          productCodes: [fixture.coordinates.productCode],
        }),
      ]);

      expect(reservations.filter(Boolean)).toHaveLength(1);
      expect(reservations.filter((reservation) => reservation === null)).toHaveLength(1);

      const account = await loadAccount(fixture);
      expect(account).toMatchObject({
        grantedUnits: 1,
        remainingUnits: 0,
        reservedUnits: 1,
      });
      const reserveEntries = await prisma.serviceEntitlementLedgerEntry.count({
        where: {
          entitlementAccountId: account.id,
          kind: ServiceEntitlementLedgerKind.RESERVE,
        },
      });
      expect(reserveEntries).toBe(1);
      expectConserved(account, { consumedUnits: 0 });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("keeps payment and entitlement facts conserved when consume races refund", async () => {
    const fixture = await createFixture();
    try {
      const generationRunId = await createGenerationRun(fixture, "consume-refund");
      const payment = paymentFixture(fixture);
      await createServicePaymentOrder(payment.order);
      await fulfillServicePaymentOrder(payment.paidEvidence);
      const reservation = await requireReservation(
        fixture,
        generationRunId,
      );

      const [consumeResult, refundResult] = await Promise.allSettled([
        consumeConversationEntitlement(reservation),
        refundServiceEntitlement(payment.refundEvidence),
      ]);

      expect(consumeResult.status).toBe("fulfilled");
      expect(refundResult.status).toBe("rejected");
      if (refundResult.status === "rejected") {
        expect(String(refundResult.reason)).toContain(
          "requires all granted units to remain available",
        );
      }

      const [account, order, events, ledger] = await Promise.all([
        loadAccount(fixture),
        prisma.servicePaymentOrder.findUniqueOrThrow({
          where: { id: payment.order.id },
        }),
        prisma.servicePaymentEvent.findMany({
          where: { paymentOrderId: payment.order.id },
        }),
        prisma.serviceEntitlementLedgerEntry.findMany({
          where: {
            entitlementAccount: {
              audienceIdentityId: fixture.sourceAudienceIdentityId,
              representativeId: fixture.representativeId,
              productCode: fixture.coordinates.productCode,
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      ]);
      expect(order.status).toBe(RechargeOrderStatus.PAID);
      expect(order.refundedAt).toBeNull();
      expect(events).toHaveLength(1);
      expect(ledger.map((entry) => entry.kind)).toEqual([
        ServiceEntitlementLedgerKind.GRANT,
        ServiceEntitlementLedgerKind.RESERVE,
        ServiceEntitlementLedgerKind.CONSUME,
      ]);
      expect(account).toMatchObject({
        grantedUnits: 1,
        remainingUnits: 0,
        reservedUnits: 0,
      });
      expectConserved(account, { consumedUnits: 1 });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("serializes consume against reservation void so only one terminal ledger fact wins", async () => {
    const fixture = await createFixture();
    try {
      const generationRunId = await createGenerationRun(fixture, "consume-void");
      await grantServiceEntitlement({
        ...fixture.coordinates,
        units: 1,
        operationKey: `${fixture.suffix}:grant:void-race`,
      });
      const reservation = await requireReservation(fixture, generationRunId);

      const terminalResults = await Promise.allSettled([
        consumeConversationEntitlement(reservation),
        releaseConversationEntitlement(reservation),
      ]);
      expect(terminalResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(terminalResults.filter((result) => result.status === "rejected")).toHaveLength(1);

      const account = await loadAccount(fixture);
      const terminalEntries = await prisma.serviceEntitlementLedgerEntry.findMany({
        where: {
          entitlementAccountId: account.id,
          kind: {
            in: [
              ServiceEntitlementLedgerKind.CONSUME,
              ServiceEntitlementLedgerKind.RELEASE,
            ],
          },
        },
      });
      expect(terminalEntries).toHaveLength(1);
      expect(account.reservedUnits).toBe(0);
      const consumedUnits =
        terminalEntries[0]?.kind === ServiceEntitlementLedgerKind.CONSUME ? 1 : 0;
      expectConserved(account, { consumedUnits });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("either rejects a concurrent identity merge or transfers the active reservation atomically", async () => {
    const fixture = await createFixture({ withRegisteredTarget: true });
    try {
      const generationRunId = await createGenerationRun(fixture, "merge");
      await grantServiceEntitlement({
        ...fixture.coordinates,
        units: 1,
        operationKey: `${fixture.suffix}:grant:merge`,
      });
      const reservation = await requireReservation(fixture, generationRunId);

      const [mergeResult, consumeResult] = await Promise.allSettled([
        mergeAudienceIdentity({
          sourceAudienceIdentityId: fixture.sourceAudienceIdentityId,
          targetAudienceIdentityId: fixture.targetAudienceIdentityId!,
          transferVerifiedProvisionalAssets: true,
        }),
        consumeConversationEntitlement(reservation),
      ]);

      expect(consumeResult.status).toBe("fulfilled");
      const [sourceIdentity, account] = await Promise.all([
        prisma.audienceIdentity.findUniqueOrThrow({
          where: { id: fixture.sourceAudienceIdentityId },
        }),
        prisma.serviceEntitlementAccount.findUniqueOrThrow({
          where: { id: reservation.accountId },
        }),
      ]);
      expect(account).toMatchObject({
        grantedUnits: 1,
        remainingUnits: 0,
        reservedUnits: 0,
      });
      expectConserved(account, { consumedUnits: 1 });

      if (mergeResult.status === "fulfilled") {
        expect(sourceIdentity).toMatchObject({
          status: AudienceIdentityStatus.MERGED,
          mergedIntoId: fixture.targetAudienceIdentityId,
        });
        expect(account.audienceIdentityId).toBe(fixture.targetAudienceIdentityId);
      } else {
        expect(sourceIdentity).toMatchObject({
          status: AudienceIdentityStatus.ANONYMOUS,
          mergedIntoId: null,
        });
        expect(account.audienceIdentityId).toBe(fixture.sourceAudienceIdentityId);
        expect(isExpectedSerializableMergeRejection(mergeResult.reason)).toBe(true);
      }
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("releases by generation run idempotently and permits the next reservation attempt", async () => {
    const fixture = await createFixture();
    try {
      const generationRunId = await createGenerationRun(fixture, "release-retry");
      await grantServiceEntitlement({
        ...fixture.coordinates,
        units: 1,
        operationKey: `${fixture.suffix}:grant:release-retry`,
      });
      const firstReservation = await requireReservation(fixture, generationRunId);
      expect(firstReservation.attempt).toBe(1);

      const releaseResults = await Promise.all([
        releaseConversationEntitlementByGenerationRunId({
          generationRunId,
          reason: "postgres-concurrency-probe-a",
        }),
        releaseConversationEntitlementByGenerationRunId({
          generationRunId,
          reason: "postgres-concurrency-probe-b",
        }),
      ]);
      expect(releaseResults.filter(Boolean)).toHaveLength(1);
      await expect(
        releaseConversationEntitlementByGenerationRunId({ generationRunId }),
      ).resolves.toBeNull();

      const secondReservation = await requireReservation(fixture, generationRunId);
      expect(secondReservation).toMatchObject({
        accountId: firstReservation.accountId,
        attempt: 2,
      });
      const account = await loadAccount(fixture);
      expect(account).toMatchObject({
        grantedUnits: 1,
        remainingUnits: 0,
        reservedUnits: 1,
      });
      const entries = await prisma.serviceEntitlementLedgerEntry.findMany({
        where: { generationRunId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(entries.map((entry) => entry.kind)).toEqual([
        ServiceEntitlementLedgerKind.RESERVE,
        ServiceEntitlementLedgerKind.RELEASE,
        ServiceEntitlementLedgerKind.RESERVE,
      ]);
      expect(entries.map((entry) => entry.idempotencyKey)).toEqual([
        `conversation-entitlement:${generationRunId}:1:reserve`,
        `conversation-entitlement:${generationRunId}:1:release`,
        `conversation-entitlement:${generationRunId}:2:reserve`,
      ]);
      expectConserved(account, { consumedUnits: 0 });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("lets human takeover fence a claimed completion and release its entitlement", async () => {
    const fixture = await createFixture();
    try {
      const claimed = await createClaimedGenerationRun(
        fixture,
        "human-takeover",
      );
      await grantServiceEntitlement({
        ...fixture.coordinates,
        units: 1,
        operationKey: `${fixture.suffix}:grant:human-takeover`,
      });
      const reservation = await requireReservation(fixture, claimed.runId);

      await assignConversationOperator({
        representativeSlug: fixture.representativeSlug,
        conversationId: fixture.conversationId,
        operatorId: fixture.ownerId,
        operatorName: "Fixture operator",
      });

      await expect(
        completeInlineGenerationRun({
          conversationId: fixture.conversationId,
          runId: claimed.runId,
          outboxId: claimed.outboxId,
          leaseAttempt: claimed.leaseAttempt,
          replyText: "This stale AI reply must not be persisted.",
          senderDisplayName: "Entitlement concurrency probe",
          completeOutbox: false,
          countUsage: true,
          entitlementReservation: reservation,
        }),
      ).rejects.toBeInstanceOf(GenerationWorkLeaseLostError);

      const [conversation, episode, run, outbox, account, ledger, aiReplyCount] =
        await Promise.all([
          prisma.conversation.findUniqueOrThrow({
            where: { id: fixture.conversationId },
            select: { state: true, assignedOperatorId: true },
          }),
          prisma.conversationEpisode.findUniqueOrThrow({
            where: { id: claimed.episodeId },
            select: { status: true },
          }),
          prisma.generationRun.findUniqueOrThrow({
            where: { id: claimed.runId },
            select: { status: true, outputMessageId: true },
          }),
          prisma.outboxEvent.findUniqueOrThrow({
            where: { id: claimed.outboxId },
            select: { status: true, processedAt: true },
          }),
          loadAccount(fixture),
          prisma.serviceEntitlementLedgerEntry.findMany({
            where: { generationRunId: claimed.runId },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          }),
          prisma.message.count({
            where: {
              conversationId: fixture.conversationId,
              senderType: MessageSenderType.REPRESENTATIVE,
            },
          }),
        ]);

      expect(conversation).toEqual({
        state: "HUMAN_ACTIVE",
        assignedOperatorId: fixture.ownerId,
      });
      expect(episode.status).toBe(ConversationEpisodeStatus.HUMAN_ACTIVE);
      expect(run).toEqual({
        status: GenerationRunStatus.WAITING_HUMAN,
        outputMessageId: null,
      });
      expect(outbox).toMatchObject({
        status: ReliableEventStatus.PROCESSED,
        processedAt: expect.any(Date),
      });
      expect(aiReplyCount).toBe(0);
      expect(ledger.map((entry) => entry.kind)).toEqual([
        ServiceEntitlementLedgerKind.RESERVE,
        ServiceEntitlementLedgerKind.RELEASE,
      ]);
      expect(account).toMatchObject({
        grantedUnits: 1,
        remainingUnits: 1,
        reservedUnits: 0,
      });
      expectConserved(account, { consumedUnits: 0 });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("lets a message edit replace claimed work before the stale completion commits", async () => {
    const fixture = await createFixture();
    try {
      const claimed = await createClaimedGenerationRun(
        fixture,
        "message-edit-first",
      );

      const edited = await editConversationMessage({
        representativeSlug: fixture.representativeSlug,
        conversationId: fixture.conversationId,
        messageId: claimed.inputMessageId,
        text: "PostgreSQL entitlement input message-edit-first, revised",
        editedBy: fixture.ownerId,
      });
      expect(edited.action).toBe("cancel_and_requeue");

      await expect(
        completeInlineGenerationRun({
          conversationId: fixture.conversationId,
          runId: claimed.runId,
          outboxId: claimed.outboxId,
          leaseAttempt: claimed.leaseAttempt,
          replyText: "This reply belongs to the stale pre-edit input.",
          senderDisplayName: "Entitlement concurrency probe",
          completeOutbox: false,
          countUsage: false,
        }),
      ).rejects.toBeInstanceOf(GenerationWorkLeaseLostError);

      const [runs, oldOutbox, aiReplyCount] = await Promise.all([
        prisma.generationRun.findMany({
          where: { inputMessageId: claimed.inputMessageId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, status: true },
        }),
        prisma.outboxEvent.findUniqueOrThrow({
          where: { id: claimed.outboxId },
          select: { status: true, processedAt: true },
        }),
        prisma.message.count({
          where: {
            conversationId: fixture.conversationId,
            senderType: MessageSenderType.REPRESENTATIVE,
          },
        }),
      ]);
      expect(runs).toHaveLength(2);
      expect(runs.find((run) => run.id === claimed.runId)?.status).toBe(
        GenerationRunStatus.CANCELED,
      );
      expect(
        runs.find((run) => run.id !== claimed.runId)?.status,
      ).toBe(GenerationRunStatus.QUEUED);
      expect(oldOutbox).toMatchObject({
        status: ReliableEventStatus.PROCESSED,
        processedAt: expect.any(Date),
      });
      expect(aiReplyCount).toBe(0);
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("preserves a completed reply when completion wins before the message edit", async () => {
    const fixture = await createFixture();
    try {
      const claimed = await createClaimedGenerationRun(
        fixture,
        "completion-first",
      );
      const completed = await completeInlineGenerationRun({
        conversationId: fixture.conversationId,
        runId: claimed.runId,
        outboxId: claimed.outboxId,
        leaseAttempt: claimed.leaseAttempt,
        replyText: "This reply completed before the edit.",
        senderDisplayName: "Entitlement concurrency probe",
        countUsage: false,
      });

      const edited = await editConversationMessage({
        representativeSlug: fixture.representativeSlug,
        conversationId: fixture.conversationId,
        messageId: claimed.inputMessageId,
        text: "PostgreSQL entitlement input completion-first, revised",
        editedBy: fixture.ownerId,
      });

      const runs = await prisma.generationRun.findMany({
        where: { inputMessageId: claimed.inputMessageId },
        select: { id: true, status: true, outputMessageId: true },
      });
      expect(edited.action).toBe("preserve_reply");
      expect(runs).toEqual([{
        id: claimed.runId,
        status: GenerationRunStatus.COMPLETED,
        outputMessageId: completed.message.id,
      }]);
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("cancels a completed but undelivered reply when takeover wins the channel fence", async () => {
    const fixture = await createFixture();
    try {
      const claimed = await createClaimedGenerationRun(
        fixture,
        "takeover-before-delivery",
      );
      const completed = await completeInlineGenerationRun({
        conversationId: fixture.conversationId,
        runId: claimed.runId,
        outboxId: claimed.outboxId,
        leaseAttempt: claimed.leaseAttempt,
        replyText: "This reply must stay behind the takeover fence.",
        senderDisplayName: "Entitlement concurrency probe",
        completeOutbox: false,
        countUsage: false,
      });

      await assignConversationOperator({
        representativeSlug: fixture.representativeSlug,
        conversationId: fixture.conversationId,
        operatorId: fixture.ownerId,
        operatorName: "Fixture operator",
      });

      await expect(
        prepareGenerationMessageChannelDelivery({
          conversationId: fixture.conversationId,
          runId: claimed.runId,
          outboxId: claimed.outboxId,
          leaseAttempt: claimed.leaseAttempt,
          outputMessageId: completed.message.id,
        }),
      ).rejects.toBeInstanceOf(GenerationWorkLeaseLostError);

      const [conversation, run, outbox, outputMessage] = await Promise.all([
        prisma.conversation.findUniqueOrThrow({
          where: { id: fixture.conversationId },
          select: { state: true },
        }),
        prisma.generationRun.findUniqueOrThrow({
          where: { id: claimed.runId },
          select: { status: true },
        }),
        prisma.outboxEvent.findUniqueOrThrow({
          where: { id: claimed.outboxId },
          select: { status: true },
        }),
        prisma.message.findUniqueOrThrow({
          where: { id: completed.message.id },
          select: {
            deliveryStatus: true,
            failureCode: true,
          },
        }),
      ]);
      expect(conversation.state).toBe("HUMAN_ACTIVE");
      expect(run.status).toBe(GenerationRunStatus.COMPLETED);
      expect(outbox.status).toBe(ReliableEventStatus.PROCESSED);
      expect(outputMessage).toEqual({
        deliveryStatus: MessageDeliveryStatus.CANCELED,
        failureCode: "operator_takeover_before_delivery",
      });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("requires takeover to retry while a prepared delivery is in flight", async () => {
    const fixture = await createFixture();
    try {
      await publishFixtureWebChannel(fixture);
      const claimed = await createClaimedGenerationRun(
        fixture,
        "delivery-before-takeover",
      );
      const completed = await completeInlineGenerationRun({
        conversationId: fixture.conversationId,
        runId: claimed.runId,
        outboxId: claimed.outboxId,
        leaseAttempt: claimed.leaseAttempt,
        replyText: "This reply crossed the delivery fence first.",
        senderDisplayName: "Entitlement concurrency probe",
        completeOutbox: false,
        countUsage: false,
      });

      await prepareGenerationMessageChannelDelivery({
        conversationId: fixture.conversationId,
        runId: claimed.runId,
        outboxId: claimed.outboxId,
        leaseAttempt: claimed.leaseAttempt,
        outputMessageId: completed.message.id,
      });

      await expect(assignConversationOperator({
        representativeSlug: fixture.representativeSlug,
        conversationId: fixture.conversationId,
        operatorId: fixture.ownerId,
        operatorName: "Fixture operator",
      })).rejects.toBeInstanceOf(ConversationWorkInFlightControlError);

      await markGenerationDeliveryComplete({
        runId: claimed.runId,
        outboxId: claimed.outboxId,
        leaseAttempt: claimed.leaseAttempt,
        outputMessageId: completed.message.id,
        externalMessageId: "web-delivery-fixture",
      });
      await expect(assignConversationOperator({
        representativeSlug: fixture.representativeSlug,
        conversationId: fixture.conversationId,
        operatorId: fixture.ownerId,
        operatorName: "Fixture operator",
      })).resolves.toMatchObject({
        operatorId: fixture.ownerId,
      });

      const [conversation, outbox, outputMessage] = await Promise.all([
        prisma.conversation.findUniqueOrThrow({
          where: { id: fixture.conversationId },
          select: { state: true },
        }),
        prisma.outboxEvent.findUniqueOrThrow({
          where: { id: claimed.outboxId },
          select: { status: true },
        }),
        prisma.message.findUniqueOrThrow({
          where: { id: completed.message.id },
          select: {
            deliveryStatus: true,
            externalMessageId: true,
            failureCode: true,
          },
        }),
      ]);
      expect(conversation.state).toBe("HUMAN_ACTIVE");
      expect(outbox.status).toBe(ReliableEventStatus.PROCESSED);
      expect(outputMessage).toEqual({
        deliveryStatus: MessageDeliveryStatus.SENT,
        externalMessageId: "web-delivery-fixture",
        failureCode: null,
      });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("authorizes only the handoff source run to deliver while human help is pending", async () => {
    const fixture = await createFixture();
    try {
      const claimed = await createClaimedGenerationRun(
        fixture,
        "self-handoff-delivery",
      );
      const completed = await completeInlineGenerationRun({
        conversationId: fixture.conversationId,
        runId: claimed.runId,
        outboxId: claimed.outboxId,
        leaseAttempt: claimed.leaseAttempt,
        replyText: "A human operator will follow up.",
        senderDisplayName: "Entitlement concurrency probe",
        completeOutbox: false,
        countUsage: false,
        humanHandoff: {
          reason: "AI requested human follow-up",
          summary: "The audience requested an operator.",
          kind: "support",
          priority: 80,
          source: "web",
        },
      });

      const preparation = await prepareGenerationMessageChannelDelivery({
        conversationId: fixture.conversationId,
        runId: claimed.runId,
        outboxId: claimed.outboxId,
        leaseAttempt: claimed.leaseAttempt,
        outputMessageId: completed.message.id,
      });

      expect(preparation).toMatchObject({
        conversationState: "NEEDS_HUMAN",
        allowNeedsHumanDelivery: true,
      });
      const [conversation, episode, outputMessage, handoff] = await Promise.all([
        prisma.conversation.findUniqueOrThrow({
          where: { id: fixture.conversationId },
          select: { state: true },
        }),
        prisma.conversationEpisode.findUniqueOrThrow({
          where: { id: claimed.episodeId },
          select: { status: true },
        }),
        prisma.message.findUniqueOrThrow({
          where: { id: completed.message.id },
          select: { content: true, deliveryStatus: true },
        }),
        prisma.handoffRequest.findFirst({
          where: { conversationId: fixture.conversationId },
          select: { reason: true, summary: true, recommendedPriority: true },
        }),
      ]);
      expect(conversation.state).toBe("NEEDS_HUMAN");
      expect(episode.status).toBe(ConversationEpisodeStatus.NEEDS_HUMAN);
      expect(outputMessage).toMatchObject({
        content: {
          deliveryControl: {
            allowNeedsHuman: true,
            generationRunId: claimed.runId,
          },
        },
        deliveryStatus: MessageDeliveryStatus.PROCESSING,
      });
      expect(handoff).toEqual({
        reason: "AI requested human follow-up",
        summary: "The audience requested an operator.",
        recommendedPriority: 80,
      });
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("defers and releases a stale completion after another run requests human help", async () => {
    const fixture = await createFixture();
    try {
      const claimed = await createClaimedGenerationRun(
        fixture,
        "human-state-before-completion",
      );
      await grantServiceEntitlement({
        ...fixture.coordinates,
        units: 1,
        operationKey: `${fixture.suffix}:grant:human-state-before-completion`,
      });
      const reservation = await requireReservation(fixture, claimed.runId);
      await prisma.conversation.update({
        where: { id: fixture.conversationId },
        data: { state: "NEEDS_HUMAN" },
      });
      await prisma.conversationEpisode.update({
        where: { id: claimed.episodeId },
        data: { status: ConversationEpisodeStatus.NEEDS_HUMAN },
      });

      await expect(completeInlineGenerationRun({
        conversationId: fixture.conversationId,
        runId: claimed.runId,
        outboxId: claimed.outboxId,
        leaseAttempt: claimed.leaseAttempt,
        replyText: "This stale reply must not be persisted.",
        senderDisplayName: "Entitlement concurrency probe",
        completeOutbox: false,
        countUsage: true,
        entitlementReservation: reservation,
      })).rejects.toBeInstanceOf(ConversationAiDeliveryControlError);

      const [run, outbox, ledger, aiReplyCount] = await Promise.all([
        prisma.generationRun.findUniqueOrThrow({
          where: { id: claimed.runId },
          select: { status: true, outputMessageId: true },
        }),
        prisma.outboxEvent.findUniqueOrThrow({
          where: { id: claimed.outboxId },
          select: { status: true },
        }),
        prisma.serviceEntitlementLedgerEntry.findMany({
          where: { generationRunId: claimed.runId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
        prisma.message.count({
          where: {
            conversationId: fixture.conversationId,
            senderType: MessageSenderType.REPRESENTATIVE,
          },
        }),
      ]);
      expect(run).toEqual({
        status: GenerationRunStatus.WAITING_HUMAN,
        outputMessageId: null,
      });
      expect(outbox.status).toBe(ReliableEventStatus.PROCESSED);
      expect(ledger.map((entry) => entry.kind)).toEqual([
        ServiceEntitlementLedgerKind.RESERVE,
        ServiceEntitlementLedgerKind.RELEASE,
      ]);
      expect(aiReplyCount).toBe(0);
    } finally {
      await deleteFixture(fixture);
    }
  });

  it("blocks an ordinary queued reply after the conversation enters human handoff", async () => {
    const fixture = await createFixture();
    try {
      const claimed = await createClaimedGenerationRun(
        fixture,
        "ordinary-delivery-after-handoff",
      );
      const completed = await completeInlineGenerationRun({
        conversationId: fixture.conversationId,
        runId: claimed.runId,
        outboxId: claimed.outboxId,
        leaseAttempt: claimed.leaseAttempt,
        replyText: "This ordinary reply did not request handoff.",
        senderDisplayName: "Entitlement concurrency probe",
        completeOutbox: false,
        countUsage: false,
      });
      await prisma.conversation.update({
        where: { id: fixture.conversationId },
        data: { state: "NEEDS_HUMAN" },
      });
      await prisma.conversationEpisode.update({
        where: { id: claimed.episodeId },
        data: { status: ConversationEpisodeStatus.NEEDS_HUMAN },
      });

      await expect(prepareGenerationMessageChannelDelivery({
        conversationId: fixture.conversationId,
        runId: claimed.runId,
        outboxId: claimed.outboxId,
        leaseAttempt: claimed.leaseAttempt,
        outputMessageId: completed.message.id,
      })).rejects.toBeInstanceOf(ConversationAiDeliveryControlError);

      const outputMessage = await prisma.message.findUniqueOrThrow({
        where: { id: completed.message.id },
        select: { deliveryStatus: true },
      });
      expect(outputMessage.deliveryStatus).toBe(MessageDeliveryStatus.QUEUED);
    } finally {
      await deleteFixture(fixture);
    }
  });
});

type EntitlementFixture = {
  suffix: string;
  ownerId: string;
  representativeId: string;
  representativeSlug: string;
  sourceAudienceIdentityId: string;
  targetAudienceIdentityId: string | null;
  contactId: string;
  conversationId: string;
  coordinates: {
    audienceIdentityId: string;
    representativeId: string;
    productCode: string;
  };
};

async function createFixture(
  options: { withRegisteredTarget?: boolean } = {},
): Promise<EntitlementFixture> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const owner = await prisma.owner.create({
    data: {
      displayName: `Entitlement concurrency ${suffix}`,
    },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `entitlement-concurrency-${suffix}`,
      displayName: "Entitlement concurrency probe",
      roleSummary: "PostgreSQL concurrency fixture",
      tone: "neutral",
      languages: ["en"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  const sourceIdentity = await prisma.audienceIdentity.create({
    data: {
      audienceKey: `postgres-entitlement:${suffix}:source`,
      status: AudienceIdentityStatus.ANONYMOUS,
    },
  });
  const targetIdentity = options.withRegisteredTarget
    ? await prisma.audienceIdentity.create({
        data: {
          audienceKey: `postgres-entitlement:${suffix}:target`,
          status: AudienceIdentityStatus.REGISTERED,
        },
      })
    : null;
  const contact = await prisma.contact.create({
    data: {
      representativeId: representative.id,
      audienceIdentityId: sourceIdentity.id,
      displayName: "PostgreSQL concurrency audience",
      source: "postgres-e2e",
      sourceChannel: "WEB",
      channelUserId: `postgres-entitlement:${suffix}`,
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      audienceIdentityId: sourceIdentity.id,
      channel: Channel.PRIVATE_CHAT,
      sourceChannel: "WEB",
      externalConversationId: `postgres-entitlement:${suffix}`,
    },
  });

  return {
    suffix,
    ownerId: owner.id,
    representativeId: representative.id,
    representativeSlug: representative.slug,
    sourceAudienceIdentityId: sourceIdentity.id,
    targetAudienceIdentityId: targetIdentity?.id ?? null,
    contactId: contact.id,
    conversationId: conversation.id,
    coordinates: {
      audienceIdentityId: sourceIdentity.id,
      representativeId: representative.id,
      productCode: "plan:pass",
    },
  };
}

async function createGenerationRun(
  fixture: EntitlementFixture,
  label: string,
) {
  const inputMessage = await prisma.message.create({
    data: {
      conversationId: fixture.conversationId,
      senderType: MessageSenderType.AUDIENCE,
      text: `PostgreSQL entitlement input ${label}`,
      clientMessageId: `${fixture.suffix}:${label}:input`,
    },
  });
  const run = await prisma.generationRun.create({
    data: {
      conversationId: fixture.conversationId,
      inputMessageId: inputMessage.id,
      idempotencyKey: `${fixture.suffix}:${label}:run`,
    },
  });
  return run.id;
}

async function publishFixtureWebChannel(
  fixture: EntitlementFixture,
) {
  const version = await prisma.representativeVersion.create({
    data: {
      representativeId: fixture.representativeId,
      versionNumber: 1,
      snapshot: { source: "postgres_delivery_fence_fixture" },
      publishedBy: fixture.ownerId,
    },
  });
  await prisma.representative.update({
    where: { id: fixture.representativeId },
    data: {
      lifecycleState: "PUBLISHED",
      activeVersionId: version.id,
    },
  });
  const representativeBinding =
    await prisma.representativeChannelBinding.create({
      data: {
        representativeId: fixture.representativeId,
        kind: "WEB",
        desiredState: "ACTIVE",
        healthStatus: "HEALTHY",
      },
    });
  await prisma.conversationChannelBinding.create({
    data: {
      conversationId: fixture.conversationId,
      representativeBindingId: representativeBinding.id,
      kind: "WEB",
      externalConversationId: `web:${fixture.conversationId}`,
    },
  });
}

async function createClaimedGenerationRun(
  fixture: EntitlementFixture,
  label: string,
) {
  const episode = await prisma.conversationEpisode.create({
    data: {
      conversationId: fixture.conversationId,
      sequence: 1,
      status: ConversationEpisodeStatus.ACTIVE,
    },
  });
  const inputMessage = await prisma.message.create({
    data: {
      conversationId: fixture.conversationId,
      episodeId: episode.id,
      senderType: MessageSenderType.AUDIENCE,
      text: `PostgreSQL entitlement input ${label}`,
      clientMessageId: `${fixture.suffix}:${label}:input`,
      deliveryStatus: MessageDeliveryStatus.PROCESSING,
    },
  });
  const run = await prisma.generationRun.create({
    data: {
      conversationId: fixture.conversationId,
      episodeId: episode.id,
      inputMessageId: inputMessage.id,
      status: GenerationRunStatus.PROCESSING,
      idempotencyKey: `${fixture.suffix}:${label}:run`,
      startedAt: new Date(),
    },
  });
  const leaseAttempt = 1;
  const outbox = await prisma.outboxEvent.create({
    data: {
      conversationId: fixture.conversationId,
      aggregateType: "generation_run",
      aggregateId: run.id,
      eventType: "generation.requested",
      payload: {
        runId: run.id,
        conversationId: fixture.conversationId,
        messageId: inputMessage.id,
      },
      idempotencyKey: `generation.requested:${run.id}`,
      status: ReliableEventStatus.PROCESSING,
      attemptCount: leaseAttempt,
      availableAt: new Date(Date.now() + 60_000),
    },
  });
  await prisma.conversation.update({
    where: { id: fixture.conversationId },
    data: {
      activeEpisodeId: episode.id,
      state: "PROCESSING",
    },
  });
  return {
    episodeId: episode.id,
    inputMessageId: inputMessage.id,
    runId: run.id,
    outboxId: outbox.id,
    leaseAttempt,
  };
}

async function requireReservation(
  fixture: EntitlementFixture,
  generationRunId: string,
): Promise<ConversationEntitlementReservation> {
  const reservation = await reserveConversationEntitlement({
    ...fixture.coordinates,
    generationRunId,
    productCodes: [fixture.coordinates.productCode],
  });
  if (!reservation) {
    throw new Error("Expected a service entitlement reservation.");
  }
  return reservation;
}

function paymentFixture(fixture: EntitlementFixture) {
  const order = {
    id: `service-payment-${fixture.suffix}`,
    payerAudienceIdentityId: fixture.sourceAudienceIdentityId,
    representativeId: fixture.representativeId,
    provider: PaymentProvider.STRIPE,
    providerAccountId: `stripe-account-${fixture.suffix}`,
    providerOrderId: `stripe-order-${fixture.suffix}`,
    productCode: fixture.coordinates.productCode,
    amountMinor: 100,
    currency: "CNY",
    entitlementUnits: 1,
    priceSnapshot: {
      amountMinor: 100,
      currency: "CNY",
      entitlementUnits: 1,
    },
    status: "REQUIRES_PAYMENT" as const,
  };
  const paidEvidence = {
    paymentOrderId: order.id,
    provider: order.provider,
    providerAccountId: order.providerAccountId,
    providerOrderId: order.providerOrderId,
    providerEventId: `stripe-paid-${fixture.suffix}`,
    payerAudienceIdentityId: order.payerAudienceIdentityId,
    amountMinor: order.amountMinor,
    currency: order.currency,
    verifiedAt: new Date(),
    rawPayload: { signatureVerified: true },
  } satisfies ServicePaymentEvidenceInput;
  return {
    order,
    paidEvidence,
    refundEvidence: {
      ...paidEvidence,
      providerEventId: `stripe-refund-${fixture.suffix}`,
      verifiedAt: new Date(Date.now() + 1_000),
    } satisfies ServicePaymentEvidenceInput,
  };
}

async function loadAccount(fixture: EntitlementFixture) {
  return prisma.serviceEntitlementAccount.findFirstOrThrow({
    where: {
      representativeId: fixture.representativeId,
      productCode: fixture.coordinates.productCode,
    },
  });
}

function expectConserved(
  account: {
    grantedUnits: number;
    remainingUnits: number;
    reservedUnits: number;
  },
  input: { consumedUnits: number },
) {
  expect(account.remainingUnits).toBeGreaterThanOrEqual(0);
  expect(account.reservedUnits).toBeGreaterThanOrEqual(0);
  expect(
    account.remainingUnits + account.reservedUnits + input.consumedUnits,
  ).toBe(account.grantedUnits);
}

function isExpectedSerializableMergeRejection(error: unknown) {
  const message = String(error);
  return (
    message.includes("P2034") ||
    message.toLowerCase().includes("write conflict") ||
    message.toLowerCase().includes("deadlock") ||
    message.includes("Audience identity merge conflict")
  );
}

async function deleteFixture(fixture: EntitlementFixture) {
  await prisma.$transaction(async (tx) => {
    await tx.conversationStateTransition.deleteMany({
      where: { conversationId: fixture.conversationId },
    });
    await tx.conversationAssignment.deleteMany({
      where: { conversationId: fixture.conversationId },
    });
    await tx.servicePaymentEvent.deleteMany({
      where: {
        paymentOrder: {
          representativeId: fixture.representativeId,
        },
      },
    });
    await tx.serviceEntitlementLedgerEntry.deleteMany({
      where: {
        entitlementAccount: {
          representativeId: fixture.representativeId,
        },
      },
    });
    await tx.servicePaymentOrder.deleteMany({
      where: { representativeId: fixture.representativeId },
    });
    await tx.serviceEntitlementAccount.deleteMany({
      where: { representativeId: fixture.representativeId },
    });
    await tx.outboxEvent.deleteMany({
      where: { conversationId: fixture.conversationId },
    });
    await tx.handoffRequest.deleteMany({
      where: { contactId: fixture.contactId },
    });
    await tx.generationRun.deleteMany({
      where: { conversationId: fixture.conversationId },
    });
    await tx.message.deleteMany({
      where: { conversationId: fixture.conversationId },
    });
    await tx.conversationEpisode.deleteMany({
      where: { conversationId: fixture.conversationId },
    });
    await tx.conversation.delete({
      where: { id: fixture.conversationId },
    });
    await tx.contact.delete({
      where: { id: fixture.contactId },
    });
    await tx.audienceIdentity.deleteMany({
      where: {
        id: {
          in: [
            fixture.sourceAudienceIdentityId,
            ...(fixture.targetAudienceIdentityId
              ? [fixture.targetAudienceIdentityId]
              : []),
          ],
        },
      },
    });
    await tx.representative.delete({
      where: { id: fixture.representativeId },
    });
    await tx.owner.delete({
      where: { id: fixture.ownerId },
    });
  });
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error(
      "DATABASE_URL is required for the service entitlement PostgreSQL E2E.",
    );
  }

  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1" ||
    !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "Remote PostgreSQL E2E is blocked. Use an explicitly named staging/test/rehearsal database and set DELEGATE_POSTGRES_E2E_ALLOW_REMOTE=1.",
    );
  }
}
