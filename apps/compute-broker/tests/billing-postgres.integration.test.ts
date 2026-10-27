import { AudienceIdentityStatus, CapabilityKind, Channel, ComputeLeaseStatus, ComputeRequestedBy, ComputeRunnerType, ComputeSessionStatus, ToolExecutionStatus } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { recordExecutionCosts } from "../src/billing";
import { prisma } from "../src/prisma";
const suite = process.env.DELEGATE_POSTGRES_E2E === "1" ? describe : describe.skip;
if (process.env.DELEGATE_POSTGRES_E2E === "1") {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/delegate_entitlement_test") throw new Error("Disposable entitlement test database required.");
}
suite("execution cost PostgreSQL concurrency", () => {
  afterAll(() => prisma.$disconnect());
  it("records concurrent replay of the same execution only once", async () => {
    const f = await createFixture(); const input = costInput(f, 0);
    const results = await Promise.all([recordExecutionCosts(input), recordExecutionCosts(input)]);
    expect(results[0]).toEqual(results[1]);
    expect(await prisma.ledgerEntry.count({ where: { toolExecutionId: input.toolExecutionId } })).toBe(2);
    const costs = await prisma.ledgerEntry.aggregate({ where: { toolExecutionId: input.toolExecutionId }, _sum: { costCents: true } });
    expect(costs._sum.costCents).toBe(3);
  });
  it("preserves both independent executions sharing one conversation", async () => {
    const f = await createFixture();
    await Promise.all([recordExecutionCosts(costInput(f, 0)), recordExecutionCosts(costInput(f, 1))]);
    expect(await prisma.ledgerEntry.count({ where: { sessionId: f.sessionId } })).toBe(4);
    expect((await prisma.ledgerEntry.aggregate({ where: { sessionId: f.sessionId }, _sum: { costCents: true } }))._sum.costCents).toBe(6);
  });
  it("rejects a stale execution lease without cost rows", async () => {
    const f = await createFixture();
    await expect(recordExecutionCosts({ ...costInput(f, 0), expectedExecutionLeaseToken: "stale" })).rejects.toMatchObject({ message: "compute_execution_claim_lost" });
    expect(await prisma.ledgerEntry.count({ where: { sessionId: f.sessionId } })).toBe(0);
  });
});
function costInput(f: BillingFixture, index: number) {
  return { representativeId: f.representativeId, contactId: f.contactId, conversationId: f.conversationId, sessionId: f.sessionId,
    toolExecutionId: f.executions[index]!.id, expectedExecutionLeaseToken: f.executions[index]!.executionLeaseToken,
    computeCostCents: 2, storageCostCents: 1, browserCostCents: 0, providerCostCents: 0, mcpCostCents: 0,
    capability: "exec" as const, wallMs: 1000, artifactBytes: 128, finishedAt: new Date() };
}
// Keep synthetic ledger evidence until the owning pg16 runner destroys the DB.
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
