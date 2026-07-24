import {
  AudienceIdentityStatus,
  CapabilityKind,
  Channel,
  ComputeLeaseStatus,
  ComputeRequestedBy,
  ComputeRunnerType,
  ComputeSessionStatus,
  ToolExecutionStatus,
} from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { applyExecutionBilling } from "../src/billing";
import { prisma } from "../src/prisma";

const describePostgres =
  process.env.DELEGATE_POSTGRES_E2E === "1" ? describe : describe.skip;

if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  assertSafePostgresE2eTarget();
}

describePostgres("compute billing PostgreSQL concurrency", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("serializes two executions against the same wallet and conversation budget", async () => {
    const fixture = await createFixture();
    try {
      const results = await Promise.all(
        fixture.executions.map((execution) =>
          applyExecutionBilling({
            representativeId: fixture.representativeId,
            contactId: fixture.contactId,
            conversationId: fixture.conversationId,
            sessionId: fixture.sessionId,
            toolExecutionId: execution.id,
            ownerId: fixture.ownerId,
            computeCredits: 5,
            storageCredits: 0,
            computeCostCents: 1,
            browserCostCents: 0,
            providerCostCents: 0,
            mcpCostCents: 0,
            storageCostCents: 0,
            capability: "write",
            wallMs: 1_000,
            artifactBytes: 0,
            finishedAt: new Date(),
            expectedExecutionLeaseToken: execution.executionLeaseToken,
          }),
        ),
      );

      expect(results.map((result) => result.actualCredits)).toEqual([5, 5]);
      const [conversation, wallet, planDebit] = await Promise.all([
        prisma.conversation.findUniqueOrThrow({
          where: { id: fixture.conversationId },
          select: { computeBudgetRemainingCredits: true },
        }),
        prisma.wallet.findUniqueOrThrow({
          where: { ownerId: fixture.ownerId },
          select: { balanceCredits: true, sponsorPoolCredit: true },
        }),
        prisma.ledgerEntry.aggregate({
          where: {
            toolExecutionId: {
              in: fixture.executions.map((execution) => execution.id),
            },
            kind: "PLAN_DEBIT",
          },
          _sum: { creditDelta: true },
        }),
      ]);
      expect(conversation.computeBudgetRemainingCredits).toBe(0);
      expect(wallet).toEqual({
        balanceCredits: 0,
        sponsorPoolCredit: 0,
      });
      expect(planDebit._sum.creditDelta).toBe(-10);
    } finally {
      await deleteFixture(fixture);
    }
  });
});

type BillingFixture = {
  ownerId: string;
  representativeId: string;
  audienceIdentityId: string;
  contactId: string;
  conversationId: string;
  sessionId: string;
  executions: Array<{
    id: string;
    executionLeaseToken: string;
  }>;
};

async function createFixture(): Promise<BillingFixture> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const owner = await prisma.owner.create({
    data: {
      displayName: `Compute billing ${suffix}`,
      wallet: {
        create: {
          balanceCredits: 4,
          sponsorPoolCredit: 0,
        },
      },
    },
  });
  const representative = await prisma.representative.create({
    data: {
      ownerId: owner.id,
      slug: `compute-billing-${suffix}`,
      displayName: "Compute billing probe",
      roleSummary: "PostgreSQL compute billing fixture",
      tone: "neutral",
      languages: ["en"],
      freeScope: [],
      paywalledIntents: [],
      handoffPrompt: "Escalate.",
      allowedSkills: [],
      actionGate: {},
    },
  });
  const audienceIdentity = await prisma.audienceIdentity.create({
    data: {
      audienceKey: `compute-billing:${suffix}`,
      status: AudienceIdentityStatus.ANONYMOUS,
    },
  });
  const contact = await prisma.contact.create({
    data: {
      representativeId: representative.id,
      audienceIdentityId: audienceIdentity.id,
      displayName: "Compute billing audience",
      source: "postgres-e2e",
      sourceChannel: "WEB",
      channelUserId: `compute-billing:${suffix}`,
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      audienceIdentityId: audienceIdentity.id,
      channel: Channel.PRIVATE_CHAT,
      sourceChannel: "WEB",
      externalConversationId: `compute-billing:${suffix}`,
      computeBudgetRemainingCredits: 6,
    },
  });
  const session = await prisma.computeSession.create({
    data: {
      representativeId: representative.id,
      contactId: contact.id,
      conversationId: conversation.id,
      requestedBy: ComputeRequestedBy.SYSTEM,
      status: ComputeSessionStatus.RUNNING,
      leaseStatus: ComputeLeaseStatus.READY,
      runnerType: ComputeRunnerType.DOCKER,
      baseImage: "debian:bookworm-slim",
      leaseTokenHash: `billing-lease-${suffix}`,
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const executions = await Promise.all(
    [1, 2].map((sequence) =>
      prisma.toolExecution.create({
        data: {
          sessionId: session.id,
          capability: CapabilityKind.WRITE,
          status: ToolExecutionStatus.RUNNING,
          executionLeaseToken: `billing-execution-${suffix}-${sequence}`,
          startedAt: new Date(),
        },
        select: {
          id: true,
          executionLeaseToken: true,
        },
      }),
    ),
  );
  return {
    ownerId: owner.id,
    representativeId: representative.id,
    audienceIdentityId: audienceIdentity.id,
    contactId: contact.id,
    conversationId: conversation.id,
    sessionId: session.id,
    executions: executions.map((execution) => ({
      id: execution.id,
      executionLeaseToken: execution.executionLeaseToken!,
    })),
  };
}

async function deleteFixture(fixture: BillingFixture) {
  await prisma.$transaction(async (tx) => {
    await tx.ledgerEntry.deleteMany({
      where: { representativeId: fixture.representativeId },
    });
    await tx.toolExecution.deleteMany({
      where: { sessionId: fixture.sessionId },
    });
    await tx.computeSession.delete({
      where: { id: fixture.sessionId },
    });
    await tx.conversation.delete({
      where: { id: fixture.conversationId },
    });
    await tx.contact.delete({
      where: { id: fixture.contactId },
    });
    await tx.audienceIdentity.delete({
      where: { id: fixture.audienceIdentityId },
    });
    await tx.representative.delete({
      where: { id: fixture.representativeId },
    });
    await tx.wallet.delete({
      where: { ownerId: fixture.ownerId },
    });
    await tx.owner.delete({
      where: { id: fixture.ownerId },
    });
  });
}

function assertSafePostgresE2eTarget() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for compute billing PostgreSQL E2E.");
  }
  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
  ) {
    return;
  }
  const databaseName = url.pathname.replace(/^\/+/u, "");
  if (
    process.env.DELEGATE_POSTGRES_E2E_ALLOW_REMOTE !== "1"
    || !/(?:^|[_-])(staging|test|rehearsal)(?:$|[_-])/iu.test(databaseName)
  ) {
    throw new Error(
      "Remote PostgreSQL E2E is blocked. Use an explicit staging/test/rehearsal database and opt in.",
    );
  }
}
