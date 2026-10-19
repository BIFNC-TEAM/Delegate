import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/prisma";
import { getRepresentativeSetupSnapshot, updateRepresentativeSetup } from "../src/representative-setup";

const enabled = process.env.DELEGATE_POSTGRES_E2E === "1";
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("isolated_policy_database_required");
}

(enabled ? describe : describe.skip)("owner overlays survive representative setup saves (PostgreSQL)", () => {
  afterAll(async () => prisma.$disconnect());

  it("initializes absent owner profiles once without reintroducing the retired platform browser rule", async () => {
    const rep = await fixture();
    await save(rep.slug);
    const profiles = await overlays(rep.ownerId);
    expect(profiles).toHaveLength(2);
    expect(profiles.every(profile => profile.rules.length === 2)).toBe(true);
    expect(profiles.flatMap(profile => profile.rules).filter(rule => rule.capability === "BROWSER")
      .every(rule => rule.decision === "ASK" && rule.requiresHumanApproval)).toBe(true);
    expect(await prisma.capabilityPolicyRule.findUnique({ where: { id: `cap_profile_managed_${rep.id}_browser_paid_private` } })).toBeNull();
    await save(rep.slug);
    expect(await overlays(rep.ownerId)).toEqual(profiles);
  });

  it("preserves owner ALLOW/DENY, disabled profiles, and custom rules when saving either representative", async () => {
    const rep = await fixture();
    await save(rep.slug);
    const baselineId = `cap_profile_owner_baseline_${rep.ownerId}`;
    const trustedId = `cap_profile_owner_trusted_${rep.ownerId}`;
    await prisma.capabilityPolicyProfile.update({ where: { id: baselineId }, data: { enabled: false, precedence: 81 } });
    await prisma.capabilityPolicyRule.update({ where: { id: `${baselineId}_browser_baseline` }, data: { decision: "ALLOW", requiresHumanApproval: false } });
    await prisma.capabilityPolicyRule.update({ where: { id: `${trustedId}_browser_trusted` }, data: { decision: "DENY", requiresHumanApproval: false } });
    await prisma.capabilityPolicyRule.create({ data: { profileId: baselineId, capability: "WRITE", decision: "DENY", priority: 500 } });
    const before = await overlays(rep.ownerId);
    await save(rep.slug);
    expect(await overlays(rep.ownerId)).toEqual(before);
    const second = await fixture(rep.ownerId);
    await save(second.slug);
    expect(await overlays(rep.ownerId)).toEqual(before);
  });

  it("initializes only a missing profile without replacing a surviving owner's rules", async () => {
    const rep = await fixture();
    await save(rep.slug);
    const trustedId = `cap_profile_owner_trusted_${rep.ownerId}`;
    const baselineId = `cap_profile_owner_baseline_${rep.ownerId}`;
    await prisma.capabilityPolicyRule.update({ where: { id: `${baselineId}_browser_baseline` }, data: { decision: "ALLOW", requiresHumanApproval: false } });
    const baseline = (await overlays(rep.ownerId)).find(profile => profile.id === baselineId);
    await prisma.capabilityPolicyRule.deleteMany({ where: { profileId: trustedId } });
    await prisma.capabilityPolicyProfile.delete({ where: { id: trustedId } });
    await save(rep.slug);
    const after = await overlays(rep.ownerId);
    expect(after.find(profile => profile.id === baselineId)).toEqual(baseline);
    expect(after.find(profile => profile.id === trustedId)?.rules).toHaveLength(2);
  });
});

function overlays(ownerId: string) {
  return prisma.capabilityPolicyProfile.findMany({ where: { ownerId, managedSource: "owner-managed" }, orderBy: { id: "asc" }, include: { rules: { orderBy: { id: "asc" } } } });
}
async function save(slug: string) {
  const setup = await getRepresentativeSetupSnapshot(slug);
  if (!setup) throw new Error("fixture_setup_missing");
  return updateRepresentativeSetup({ representativeSlug: slug, input: { ...setup, tone: "Synthetic edited tone" }, syncOpenViking: false });
}
async function fixture(ownerId?: string) {
  const id = ownerId ?? (await prisma.owner.create({ data: { displayName: "Synthetic policy owner" } })).id;
  return prisma.representative.create({ data: { ownerId: id, slug: `policy-preserve-${randomUUID()}`, displayName: "Fixture", roleSummary: "Test representative", tone: "neutral",
    languages: ["zh"], freeScope: [], paywalledIntents: [], handoffPrompt: "Fixture", allowedSkills: [], actionGate: {}, humanInLoop: false, publicMode: true, computeEnabled: false,
    knowledgePack: { create: { identitySummary: "Synthetic identity", faq: [], materials: [], policies: [] } },
  } });
}
