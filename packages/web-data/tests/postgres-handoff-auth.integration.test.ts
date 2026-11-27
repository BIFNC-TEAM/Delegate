import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { completeInlineGenerationRun, ensureConversationLeadAndHandoff } from "../src/conversation-platform";
import { createOrReuseHandoffRequestInTransaction } from "../src/handoff-entitlements";
import { prisma } from "../src/prisma";
import { fixture as generationFixture } from "./citation-postgres-fixture";

const enabled = process.env.DELEGATE_POSTGRES_E2E === "1";
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) {
    throw new Error("isolated_local_test_database_required");
  }
}

describe.skipIf(!enabled)("shared handoff account authorization on PostgreSQL", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it.each([
    "anonymous", "missing_identity", "missing_account", "suspended_account",
    "revoked_auth", "missing_auth", "merged_identity", "disabled_identity",
  ] as const)("rejects %s before handoff, lead, entitlement or conversation writes", async kind => {
    const f = await fixture();
    if (kind === "missing_identity") {
      await prisma.contact.update({ where: { id: f.contactId }, data: { audienceIdentityId: null } });
    } else if (kind === "missing_account") {
      await prisma.audienceIdentity.update({ where: { id: f.audienceId }, data: { accountId: null } });
    } else if (kind === "suspended_account") {
      await prisma.account.update({ where: { id: f.accountId }, data: { status: "SUSPENDED" } });
    } else if (kind === "revoked_auth") {
      await prisma.authIdentity.updateMany({ where: { accountId: f.accountId }, data: { status: "REVOKED" } });
    } else if (kind === "missing_auth") {
      await prisma.authIdentity.deleteMany({ where: { accountId: f.accountId } });
    } else if (kind === "merged_identity") {
      const target = await prisma.audienceIdentity.create({ data: { audienceKey: randomUUID() } });
      await prisma.audienceIdentity.update({ where: { id: f.audienceId }, data: { mergedIntoId: target.id } });
    } else {
      await prisma.audienceIdentity.update({ where: { id: f.audienceId }, data: { status: kind === "anonymous" ? "ANONYMOUS" : "DISABLED", accountId: null } });
    }
    const before = await snapshot(f);
    await expect(create(f)).rejects.toMatchObject({ code: "authentication_required", status: 401 });
    await expect(ensureConversationLeadAndHandoff({
      conversationId: f.conversationId, reason: "visitor_request", summary: "Must not create a lead", requestHandoff: true,
    })).rejects.toMatchObject({ code: "authentication_required", status: 401 });
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(["OPEN", "REVIEWING", "ACCEPTED"] as const)("does not refresh or reuse an anonymous historical %s handoff", async status => {
    const f = await fixture();
    const first = await create(f);
    await prisma.handoffRequest.update({ where: { id: first.request!.id }, data: { status } });
    await prisma.audienceIdentity.update({ where: { id: f.audienceId }, data: { status: "ANONYMOUS", accountId: null } });
    const before = await snapshot(f);
    await expect(create(f, "Must not replace history")).rejects.toMatchObject({ code: "authentication_required" });
    expect(await snapshot(f)).toEqual(before);
  });

  it("creates one free request for concurrent registered retries and still creates the legacy lead", async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([create(f), create(f)]);
    expect([first.outcome, second.outcome].sort()).toEqual(["created", "reused"]);
    expect(second.request!.id).toBe(first.request!.id);
    const legacy = await ensureConversationLeadAndHandoff({
      conversationId: f.conversationId, reason: "visitor_request", summary: "Registered request", requestHandoff: true,
    });
    expect(legacy.handoff!.id).toBe(first.request!.id);
    expect(legacy.lead).not.toBeNull();
    expect((await snapshot(f)).conversation.state).toBe("NEEDS_HUMAN");
  });

  it("rejects a contact from another representative without writing", async () => {
    const f = await fixture();
    const other = await fixture();
    const before = await snapshot(f);
    await expect(prisma.$transaction(tx => createOrReuseHandoffRequestInTransaction({
      ...draft(f), representativeId: other.representativeId,
    }, tx))).rejects.toThrow("Handoff contact does not match");
    expect(await snapshot(f)).toEqual(before);
  });

  it("rolls back the legacy generation-completion path for an anonymous handoff", async () => {
    const f = await generationFixture();
    await prisma.audienceIdentity.update({ where: { id: f.audienceId }, data: { status: "ANONYMOUS" } });
    const scope = { ...f, representativeId: f.repId };
    const before = await snapshot(scope);
    const run = await prisma.generationRun.findUniqueOrThrow({ where: { id: f.runId } });
    const messages = await prisma.message.count({ where: { conversationId: f.conversationId } });
    await expect(completeInlineGenerationRun({
      ...f.input, conversationId: f.conversationId, replyText: "No fake success", senderDisplayName: "Synthetic",
      countUsage: false, completeOutbox: false,
      humanHandoff: { reason: "visitor_request", summary: "Anonymous callback" },
    })).rejects.toMatchObject({ code: "authentication_required", status: 401 });
    expect(await snapshot(scope)).toEqual(before);
    expect(await prisma.generationRun.findUniqueOrThrow({ where: { id: f.runId } })).toEqual(run);
    expect(await prisma.message.count({ where: { conversationId: f.conversationId } })).toBe(messages);
  });
});

async function fixture() {
  const id = randomUUID();
  const owner = await prisma.owner.create({ data: { displayName: "Synthetic handoff auth owner" } });
  const representative = await prisma.representative.create({ data: {
    ownerId: owner.id, slug: `handoff-auth-${id}`, displayName: "Synthetic", roleSummary: "Test", tone: "neutral",
    languages: ["en"], freeScope: [], paywalledIntents: [], handoffPrompt: "Help", allowedSkills: [], actionGate: {},
    humanInLoop: true, handoffAccessMode: "FREE",
  } });
  const account = await prisma.account.create({ data: { authIdentities: { create: {
    provider: "LOGTO", issuer: "https://synthetic.invalid", subject: id,
    verifiedAt: new Date(), lastAuthenticatedAt: new Date(),
  } } } });
  const audience = await prisma.audienceIdentity.create({ data: { audienceKey: id, status: "REGISTERED", accountId: account.id } });
  const contact = await prisma.contact.create({ data: { representativeId: representative.id, audienceIdentityId: audience.id, sourceChannel: "web" } });
  const conversation = await prisma.conversation.create({ data: {
    representativeId: representative.id, contactId: contact.id, audienceIdentityId: audience.id, channel: "PRIVATE_CHAT", sourceChannel: "web",
  } });
  return { representativeId: representative.id, contactId: contact.id, conversationId: conversation.id, audienceId: audience.id, accountId: account.id };
}

type Scope = { representativeId: string; contactId: string; conversationId: string };
function draft(f: Scope) {
  return { ...f, reason: "visitor_request", summary: "Synthetic request", recommendedPriority: 30, recommendedOwnerAction: "Review" };
}
function create(f: Scope, summary = "Synthetic request") {
  return prisma.$transaction(tx => createOrReuseHandoffRequestInTransaction({ ...draft(f), summary }, tx));
}
async function snapshot(f: Scope) {
  const [conversation, contact, requests, leads, grants, ledger] = await Promise.all([
    prisma.conversation.findUniqueOrThrow({ where: { id: f.conversationId } }),
    prisma.contact.findUniqueOrThrow({ where: { id: f.contactId } }),
    prisma.handoffRequest.findMany({ where: { representativeId: f.representativeId }, orderBy: { id: "asc" } }),
    prisma.lead.findMany({ where: { representativeId: f.representativeId }, orderBy: { id: "asc" } }),
    prisma.handoffEntitlementGrant.findMany({ where: { representativeId: f.representativeId }, orderBy: { id: "asc" } }),
    prisma.handoffEntitlementLedgerEntry.findMany({ where: { grant: { representativeId: f.representativeId } }, orderBy: { id: "asc" } }),
  ]);
  return { conversation, contact, requests, leads, grants, ledger };
}
