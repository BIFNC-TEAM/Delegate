import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { type AgentBehavior } from "@delegate/domain";
import { activateRepresentativeVersion, publishRepresentativeVersion } from "../src/conversation-platform";
import { createRepresentative, getRepresentativeRuntimeSetupSnapshot, getRepresentativeSetupSnapshot, updateRepresentativeSetup, type RepresentativeSetupUpdateInput } from "../src/representative-setup";
import { prisma } from "../src/prisma";

const enabled = process.env.DELEGATE_POSTGRES_E2E === "1";
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("isolated_behavior_database_required");
}
const suite = enabled ? describe : describe.skip;
const closed: AgentBehavior = { version: 1, answerScope: "owner_and_domain", knowledgePolicy: "domain_only", commitmentPolicy: "information_only" };
const open: AgentBehavior = { version: 1, answerScope: "open_public", knowledgePolicy: "owner_facts", commitmentPolicy: "authorized_terms" };

suite("Agent behavior save/publish/pin against isolated PostgreSQL", () => {
  afterAll(async () => prisma.$disconnect());
  it("creates a materials-first draft through the product path and preserves an explicit later choice", async () => {
    const owner = await prisma.owner.create({ data: { displayName: "Synthetic default owner" } });
    const created = await createRepresentative({ ownerName: owner.displayName, representativeName: "Default knowledge fixture", slug: `knowledge-default-${randomUUID()}`, tagline: "地理教学" }, { ownerId: owner.id });
    expect(created.agentBehavior).toEqual({ version: 1, answerScope: "owner_and_domain", knowledgePolicy: "domain_first", commitmentPolicy: "information_only" });
    expect((await prisma.representative.findUniqueOrThrow({ where: { id: created.id } })).agentBehavior).toEqual(created.agentBehavior);
    const saved = await updateRepresentativeSetup({ representativeSlug: created.slug, input: { ...created, agentBehavior: open }, syncOpenViking: false });
    const { agentBehavior: _ignored, ...oldClient } = saved;
    await updateRepresentativeSetup({ representativeSlug: created.slug, input: { ...oldClient, tone: "Updated wording" }, syncOpenViking: false });
    expect((await getRepresentativeSetupSnapshot(created.slug))?.agentBehavior).toEqual(open);
  });
  it("keeps legacy behavior absent, saves an independent draft, pins published policy, and restores the selected version", async () => {
    const fixture = await createFixture();
    expect((await prisma.representative.findUniqueOrThrow({ where: { id: fixture.id } })).agentBehavior).toBeNull();
    const legacy = await publish(fixture);
    expect((legacy.snapshot as Record<string, unknown>).agentBehavior).toBeUndefined();
    expect((await getRepresentativeRuntimeSetupSnapshot(fixture.slug, legacy.id))?.agentBehavior).toBeUndefined();
    const before = await getRepresentativeSetupSnapshot(fixture.slug);
    const saved = await updateRepresentativeSetup({ representativeSlug: fixture.slug, input: { ...before!, agentBehavior: closed }, syncOpenViking: false });
    expect(saved.agentBehavior).toEqual(closed);
    expect((await getRepresentativeRuntimeSetupSnapshot(fixture.slug))?.agentBehavior).toBeUndefined();
    const v2 = await publish(fixture);
    expect((v2.snapshot as Record<string, unknown>).agentBehavior).toEqual(closed);
    expect((await getRepresentativeRuntimeSetupSnapshot(fixture.slug))?.agentBehavior).toEqual(closed);
    const changed = await updateRepresentativeSetup({ representativeSlug: fixture.slug, input: { ...saved, agentBehavior: open }, syncOpenViking: false });
    expect(changed.agentBehavior).toEqual(open);
    const current = await getRepresentativeRuntimeSetupSnapshot(fixture.slug, v2.id);
    expect(current?.agentBehavior).toEqual(closed); expect(current?.compute.enabled).toBe(false);
    const v3 = await publish(fixture);
    expect((await getRepresentativeRuntimeSetupSnapshot(fixture.slug))?.agentBehavior).toEqual(open);
    expect((await getRepresentativeRuntimeSetupSnapshot(fixture.slug, v2.id))?.agentBehavior).toEqual(closed);
    await activateRepresentativeVersion({ representativeSlug: fixture.slug, versionId: v2.id, activatedBy: fixture.ownerId, ownerId: fixture.ownerId });
    expect((await getRepresentativeRuntimeSetupSnapshot(fixture.slug))?.agentBehavior).toEqual(closed);
    expect((await prisma.representativeVersion.findUniqueOrThrow({ where: { id: v3.id } })).snapshot).toEqual(v3.snapshot);
    const row = await prisma.representative.findUniqueOrThrow({ where: { id: fixture.id } });
    expect(row.computeEnabled).toBe(false); expect(row.actionGate).toEqual({ fixture: "unchanged" });
    expect(await prisma.toolExecution.count({ where: { session: { representativeId: fixture.id } } })).toBe(0);
    expect(await prisma.message.count({ where: { conversation: { representativeId: fixture.id } } })).toBe(0);
  });
  it("preserves a saved policy when an older client omits the new field", async () => {
    const fixture = await createFixture();
    const setup = await getRepresentativeSetupSnapshot(fixture.slug);
    const saved = await updateRepresentativeSetup({ representativeSlug: fixture.slug, input: { ...setup!, agentBehavior: closed }, syncOpenViking: false });
    const { agentBehavior: _ignored, ...oldClient } = saved;
    await updateRepresentativeSetup({ representativeSlug: fixture.slug, input: { ...oldClient, tone: "updated tone" }, syncOpenViking: false });
    const row = await prisma.representative.findUniqueOrThrow({ where: { id: fixture.id } });
    expect(row.agentBehavior).toEqual(closed); expect(row.tone).toBe("updated tone");
  });
  it("rejects invalid behavior before writing any row or incrementing the draft revision", async () => {
    const fixture = await createFixture(); const setup = await getRepresentativeSetupSnapshot(fixture.slug);
    for (const invalid of [null, { ...open, approvalRequired: false }, { ...closed, knowledgePolicy: "never" }]) {
      await expect(updateRepresentativeSetup({ representativeSlug: fixture.slug, input: { ...setup!, agentBehavior: invalid } as unknown as RepresentativeSetupUpdateInput, syncOpenViking: false })).rejects.toThrow();
    }
    expect((await prisma.representative.findUniqueOrThrow({ where: { id: fixture.id } })).agentBehavior).toBeNull();
    expect((await getRepresentativeSetupSnapshot(fixture.slug))?.knowledgePackRevision).toBe(setup!.knowledgePackRevision);
  });
  it("uses the existing draft CAS so concurrent owners cannot silently overwrite each other's policy", async () => {
    const fixture = await createFixture(); const setup = await getRepresentativeSetupSnapshot(fixture.slug);
    const results = await Promise.allSettled([closed, open].map(agentBehavior => updateRepresentativeSetup({ representativeSlug: fixture.slug, input: { ...setup!, agentBehavior }, syncOpenViking: false })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason.code).toBe("KNOWLEDGE_PACK_CONFLICT");
    const success = results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<NonNullable<Awaited<ReturnType<typeof getRepresentativeSetupSnapshot>>>>;
    expect((await prisma.representative.findUniqueOrThrow({ where: { id: fixture.id } })).agentBehavior).toEqual(success.value.agentBehavior);
    expect(success.value.knowledgePackRevision).toBe(setup!.knowledgePackRevision + 1);
  });
  it("does not substitute draft authority when an explicit published policy is corrupt", async () => {
    const fixture = await createFixture(); const version = await publish(fixture);
    // Published rows are immutable in the real schema. Seed a separate malformed
    // historical row to exercise readers instead of weakening that constraint.
    await expect(prisma.representativeVersion.update({ where: { id: version.id }, data: { snapshot: {} } })).rejects.toThrow("published representative versions are immutable");
    expect((await prisma.representativeVersion.findUniqueOrThrow({ where: { id: version.id } })).snapshot).toEqual(version.snapshot);
    for (const [index, agentBehavior] of [{ ...open, version: 99 }, null].entries()) {
      const corrupt = await prisma.representativeVersion.create({ data: { representativeId: fixture.id, versionNumber: version.versionNumber + index + 1,
        snapshot: { ...(version.snapshot as Record<string, any>), agentBehavior } } });
      await expect(getRepresentativeRuntimeSetupSnapshot(fixture.slug, corrupt.id)).rejects.toThrow("representative_agent_behavior_invalid");
    }
  });
  it("blocks legacy or stale publishers from silently dropping or changing a configured policy", async () => {
    const fixture = await createFixture(); const legacy = await publish(fixture);
    const setup = await getRepresentativeSetupSnapshot(fixture.slug);
    await updateRepresentativeSetup({ representativeSlug: fixture.slug, input: { ...setup!, agentBehavior: closed }, syncOpenViking: false });
    for (const snapshot of [legacy.snapshot, { ...(legacy.snapshot as Record<string, any>), agentBehavior: open }]) {
      await expect(prisma.representativeVersion.create({ data: { representativeId: fixture.id, versionNumber: 2, snapshot: snapshot as any } }))
        .rejects.toThrow("representative_agent_behavior_snapshot_mismatch");
    }
    expect(await prisma.representativeVersion.count({ where: { representativeId: fixture.id } })).toBe(1);
    expect((await prisma.representative.findUniqueOrThrow({ where: { id: fixture.id } })).activeVersionId).toBe(legacy.id);
    expect((await publish(fixture)).versionNumber).toBe(2);
  });
});

async function createFixture() {
  const owner = await prisma.owner.create({ data: { displayName: "Synthetic behavior owner" } });
  return prisma.representative.create({ data: { ownerId: owner.id, slug: `behavior-${randomUUID()}`, displayName: "Fixture", roleSummary: "Geography", tone: "neutral",
    languages: ["zh"], freeScope: [], paywalledIntents: [], handoffPrompt: "Fixture", allowedSkills: [], actionGate: { fixture: "unchanged" },
    humanInLoop: false, publicMode: true, computeEnabled: false,
    knowledgePack: { create: { identitySummary: "Fixture identity", faq: [{ id: "fixture-faq", title: "Synthetic facts", kind: "faq", summary: "Synthetic public fact" }], materials: [], policies: [] } },
  } });
}
function publish(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return publishRepresentativeVersion({ representativeSlug: fixture.slug, ownerId: fixture.ownerId, publishedBy: fixture.ownerId });
}
