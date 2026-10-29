import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { controlPublicAudienceTask, getPublicGenerationRunControlSnapshot } from "../src/conversation-platform";
import { buildWebConversationThreadId } from "../src/web-audience";
import { prisma } from "../src/prisma";

const enabled = process.env.DELEGATE_POSTGRES_E2E === "1";
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("isolated_task_control_database_required");
}

const suite = enabled ? describe : describe.skip;
suite("public task control PostgreSQL boundaries", () => {
  afterAll(async () => prisma.$disconnect());

  it("reads only minimal owned state while paused without retrieving private answer bodies", async () => {
    const fixture = await createFixture();
    const queries: unknown[] = [];
    const originalTransaction = prisma.$transaction.bind(prisma);
    // The production status read runs on the transaction client, not the root
    // delegate. Observe its real SQL arguments without replacing database work.
    const transaction = vi.spyOn(prisma, "$transaction").mockImplementation((async (
      operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: Parameters<typeof prisma.$transaction>[1],
    ) => originalTransaction(async tx => {
      const generationRun = new Proxy(tx.generationRun, { get(target, key) {
        const value = Reflect.get(target, key);
        return key === "findMany" ? (...args: unknown[]) => { queries.push(args[0]); return Reflect.apply(value, target, args); } : value;
      } });
      return operation(new Proxy(tx, { get(target, key) { return key === "generationRun" ? generationRun : Reflect.get(target, key); } }));
    }, options)) as typeof prisma.$transaction);
    const findFirst = vi.spyOn(prisma.generationRun, "findFirst");
    try {
      const summary = await controlPublicAudienceTask({ ...fixture.principal, kind: "status" });
      expect(summary.tasks).toEqual([{ id: fixture.run.id, status: "queued" }]);
      expect(JSON.stringify(summary)).not.toContain("SYNTHETIC_PRIVATE_ANSWER");
      expect((queries[0] as { select: unknown }).select).toEqual({ id: true, status: true });
      const state = await getPublicGenerationRunControlSnapshot({ ...fixture.principal, runId: fixture.run.id });
      expect(state).toMatchObject({ id: fixture.run.id, status: "queued", statusOnly: true });
      expect(findFirst.mock.calls.at(-1)![0]?.select).toEqual({ id: true, status: true, updatedAt: true });
      expect(JSON.stringify(state)).not.toContain("SYNTHETIC_PRIVATE_ANSWER");
    } finally { transaction.mockRestore(); findFirst.mockRestore(); }
  });

  it.each(["QUEUED", "PROCESSING", "WAITING_APPROVAL"] as const)("records cancellation once for %s and stops its pending generation work", async status => {
    const fixture = await createFixture(status);
    const result = await controlPublicAudienceTask({ ...fixture.principal, kind: "cancel", runId: fixture.run.id });
    expect(result.outcome).toBe("cancel_requested");
    expect(result.text).toContain("实际回执");
    expect(await prisma.generationRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({ status: "CANCELED", errorCode: "audience_cancel_requested" });
    expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: fixture.outboxId } })).toMatchObject({ status: "PROCESSED" });
    const replay = await controlPublicAudienceTask({ ...fixture.principal, kind: "cancel", runId: fixture.run.id });
    expect(replay.outcome).toBe("unchanged");
    expect(await prisma.agentUsageCharge.count({ where: { generationRunId: fixture.run.id } })).toBe(0);
  });

  it("does not read or mutate another identity, device thread or representative task", async () => {
    const fixture = await createFixture();
    for (const principal of [
      { ...fixture.principal, audienceIdentityId: "another-identity" },
      { ...fixture.principal, audienceId: "another-device" },
      { ...fixture.principal, representativeSlug: "another-representative" },
    ]) {
      expect(await controlPublicAudienceTask({ ...principal, kind: "cancel", runId: fixture.run.id })).toMatchObject({ outcome: "not_found", tasks: [] });
      expect(await getPublicGenerationRunControlSnapshot({ ...principal, runId: fixture.run.id })).toBeNull();
    }
    expect(await prisma.generationRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({ status: "QUEUED" });
    expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: fixture.outboxId } })).toMatchObject({ status: "PENDING" });
  });

  it("rejects a disabled identity even with the former correct task coordinates", async () => {
    const fixture = await createFixture();
    await prisma.audienceIdentity.update({ where: { id: fixture.principal.audienceIdentityId }, data: { status: "DISABLED" } });
    expect(await controlPublicAudienceTask({ ...fixture.principal, kind: "cancel", runId: fixture.run.id })).toMatchObject({ outcome: "not_found" });
    expect(await getPublicGenerationRunControlSnapshot({ ...fixture.principal, runId: fixture.run.id })).toBeNull();
    expect(await prisma.generationRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({ status: "QUEUED" });
  });

  it("asks for a target when multiple tasks exist instead of canceling all of them", async () => {
    const fixture = await createFixture();
    const second = await prisma.generationRun.create({ data: { conversationId: fixture.run.conversationId, inputMessageId: fixture.run.inputMessageId, status: "QUEUED", idempotencyKey: randomUUID() } });
    const ambiguous = await controlPublicAudienceTask({ ...fixture.principal, kind: "cancel" });
    expect(ambiguous.outcome).toBe("needs_target");
    expect(await prisma.generationRun.count({ where: { conversationId: fixture.run.conversationId, status: "QUEUED" } })).toBe(2);
    await controlPublicAudienceTask({ ...fixture.principal, kind: "cancel", runId: second.id });
    expect(await prisma.generationRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({ status: "QUEUED" });
  });

  it("serializes concurrent repeated cancellations without creating new work or consumption", async () => {
    const fixture = await createFixture();
    const results = await Promise.all([1, 2].map(() => controlPublicAudienceTask({ ...fixture.principal, kind: "cancel", runId: fixture.run.id })));
    expect(results.map(result => result.outcome).sort()).toEqual(["cancel_requested", "unchanged"]);
    expect(await prisma.generationRun.count({ where: { conversationId: fixture.run.conversationId } })).toBe(1);
    expect(await prisma.agentUsageCharge.count({ where: { generationRunId: fixture.run.id } })).toBe(0);
  });
});

async function createFixture(status: "QUEUED" | "PROCESSING" | "WAITING_APPROVAL" = "QUEUED") {
  const suffix = randomUUID();
  const owner = await prisma.owner.create({ data: { displayName: "Task control fixture" } });
  const representative = await prisma.representative.create({ data: {
    ownerId: owner.id, slug: `task-control-${suffix}`, displayName: "Fixture", roleSummary: "Task control", tone: "neutral", languages: ["zh"],
    freeScope: [], paywalledIntents: [], handoffPrompt: "Fixture", allowedSkills: [], actionGate: {}, lifecycleState: "PAUSED",
  } });
  const identity = await prisma.audienceIdentity.create({ data: { audienceKey: `task-control:${suffix}`, status: "ANONYMOUS" } });
  const contact = await prisma.contact.create({ data: { representativeId: representative.id, audienceIdentityId: identity.id, sourceChannel: "web" } });
  const audienceId = `device-${suffix}`;
  const conversation = await prisma.conversation.create({ data: { representativeId: representative.id, contactId: contact.id, audienceIdentityId: identity.id, channel: "PRIVATE_CHAT", sourceChannel: "web", channelThreadId: buildWebConversationThreadId(audienceId) } });
  const message = await prisma.message.create({ data: { conversationId: conversation.id, senderType: "AUDIENCE", text: "SYNTHETIC_PRIVATE_ANSWER" } });
  const run = await prisma.generationRun.create({ data: { conversationId: conversation.id, inputMessageId: message.id, status, idempotencyKey: `task-control:${suffix}`, runtimePolicySnapshot: { billingMode: "free" } } });
  const outbox = await prisma.outboxEvent.create({ data: { conversationId: conversation.id, aggregateType: "generation_run", aggregateId: run.id, eventType: "generation.requested", idempotencyKey: `outbox:${suffix}`, payload: { runId: run.id }, status: "PENDING" } });
  return { run, outboxId: outbox.id, principal: { representativeSlug: representative.slug, audienceIdentityId: identity.id, audienceId } };
}
