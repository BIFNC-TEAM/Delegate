import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { publishRepresentativeVersion } from "../src/conversation-platform";
import { setServiceBoundaryDraft, readPublishedServiceBoundaries } from "../src/service-requests";
import { flushServiceRequestNotification } from "../src/service-request-notifications";
import { prisma } from "../src/prisma";
import { createServiceRequestBatch, createServiceRequest, createServiceRequestSuccessor, resolveServiceRequest, getServiceRequestChain, listServiceRequests, type ServiceRequestActor } from "../src/service-requests";
const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/none");
const enabled = process.env.DELEGATE_SERVICE_REQUEST_E2E === "1" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname.endsWith("_test");
async function fixture(actions: Record<string, string> = {}) {
  const owner = await prisma.owner.create({ data: { displayName: "Synthetic c007 owner" } });
  const rep = await prisma.representative.create({ data: { ownerId: owner.id, slug: `c007-${randomUUID()}`, displayName: "Synthetic", roleSummary: "Assistant", tone: "neutral", languages: ["zh"], freeScope: [], paywalledIntents: [], handoffPrompt: "Help", allowedSkills: [], actionGate: {} } });
  const contact = await prisma.contact.create({ data: { representativeId: rep.id, sourceChannel: "telegram" } });
  const conversation = await prisma.conversation.create({ data: { representativeId: rep.id, contactId: contact.id, channel: "PRIVATE_CHAT", sourceChannel: "telegram" } });
  const rules = ["appointment", "discount", "scope", "dispute", "human"].map(id => ({ id, request: "", action: actions[id] ?? "approve" }));
  const version = await prisma.representativeVersion.create({ data: { representativeId: rep.id, versionNumber: 1, status: "PUBLISHED", snapshot: { knowledge: { serviceBoundaries: { version: 1, boundaries: rules } } } } });
  const episode = await prisma.conversationEpisode.create({ data: { conversationId: conversation.id, representativeVersionId: version.id, sequence: 1 } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { activeEpisodeId: episode.id } });
  const visitor: ServiceRequestActor = { role: "visitor", representativeId: rep.id, contactId: contact.id, audienceIdentityId: null };
  const ownerActor: ServiceRequestActor = { role: "owner", representativeId: rep.id, ownerId: owner.id };
  const input = { actor: visitor, conversationId: conversation.id, representativeVersionId: version.id, content: "申请八折", summary: "八折", ruleIds: ["discount"], kind: "discount", idempotencyKey: "message:1" };
  return { input, visitor, ownerActor, version };
}
afterAll(async () => { if (enabled) await prisma.$disconnect(); });
describe.skipIf(!enabled)("PostgreSQL service requests", () => {
  it("rejects overflow without writes and binds a message to one complete batch manifest", async () => {
    const f = await fixture();
    const message = await prisma.message.create({ data: { conversationId: f.input.conversationId, senderType: "AUDIENCE", text: "申请" } });
    const context = { actor: f.visitor, conversationId: f.input.conversationId, representativeVersionId: f.version.id };
    const item = { itemId: "1", content: "申请八折", summary: "八折", ruleIds: ["discount"] };
    await expect(createServiceRequestBatch(context, { messageId: message.id, overflow: true, items: [item] })).rejects.toThrow("too_many_requests");
    expect(await prisma.serviceRequest.count({ where: { conversationId: f.input.conversationId } })).toBe(0);
    await createServiceRequestBatch(context, { messageId: message.id, overflow: false, items: [item] });
    await expect(createServiceRequestBatch(context, { messageId: message.id, overflow: false, items: [{ ...item, itemId: "2" }] })).rejects.toThrow("batch_manifest_conflict");
    expect(await prisma.serviceRequest.count({ where: { conversationId: f.input.conversationId } })).toBe(1);
  });
  it("dispatches handoff through entitlement governance and decline creates no request", async () => {
    const f = await fixture({ human: "handoff", scope: "decline" });
    const message = await prisma.message.create({ data: { conversationId: f.input.conversationId, senderType: "AUDIENCE", text: "本人接待和额外交付" } });
    const context = { actor: f.visitor, conversationId: f.input.conversationId, representativeVersionId: f.version.id };
    const body = { messageId: message.id, overflow: false, items: [
      { itemId: "human", content: "找本人", summary: "本人接待", ruleIds: ["human"] },
      { itemId: "scope", content: "额外交付", summary: "额外交付", ruleIds: ["scope"] },
    ] };
    const result = await createServiceRequestBatch(context, body);
    expect(result.results[0]!.status).toBe("created");
    expect(result.results[1]!.status).toBe("declined");
    await createServiceRequestBatch(context, body);
    expect(await prisma.handoffRequest.count({ where: { conversationId: f.input.conversationId } })).toBe(1);
    expect(await prisma.serviceRequest.count({ where: { conversationId: f.input.conversationId } })).toBe(0);
  });
  it("paginates by creation time and filters direction, object, state and time", async () => {
    const f = await fixture();
    const first = await createServiceRequest(f.input);
    await createServiceRequest({ ...f.input, idempotencyKey: "message:2" });
    const page = await listServiceRequests(f.ownerActor, { box: "received", ascending: true, limit: 1 });
    expect(page.items[0]!.id).toBe(first.id);
    const next = await listServiceRequests(f.ownerActor, { box: "received", ascending: true, limit: 1, cursor: page.nextCursor! });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]!.id).not.toBe(first.id);
    expect((await listServiceRequests(f.ownerActor, { box: "sent" })).items).toHaveLength(0);
    expect((await listServiceRequests(f.ownerActor, { contactId: "other" })).items).toHaveLength(0);
    expect((await listServiceRequests(f.visitor, { kind: "discount", status: "pending" })).items).toHaveLength(2);
    expect((await listServiceRequests(f.visitor, { from: new Date(Date.now() + 1000), to: new Date(Date.now() + 2000) })).items).toHaveLength(0);
  });
  it("does not bypass disabled handoff or paid entitlement requirements", async () => {
    for (const disabled of [true, false]) {
      const f = await fixture({ human: "handoff" });
      await prisma.representative.update({ where: { id: f.visitor.representativeId }, data: { humanInLoop: !disabled, handoffAccessMode: "PACKAGE_REQUIRED" } });
      const message = await prisma.message.create({ data: { conversationId: f.input.conversationId, senderType: "AUDIENCE", text: "找本人" } });
      const result = await createServiceRequestBatch({ actor: f.visitor, conversationId: f.input.conversationId, representativeVersionId: f.version.id }, { messageId: message.id, overflow: false, items: [{ itemId: "1", content: "找本人", summary: "本人接待", ruleIds: ["human"] }] });
      expect(result.results[0]!.status).toBe(disabled ? "handoff_disabled" : "entitlement_required");
      expect(await prisma.handoffRequest.count({ where: { conversationId: f.input.conversationId } })).toBe(0);
    }
  });
  it("prepares Telegram and Matrix notifications in the existing channel outbox", async () => {
    for (const channel of ["telegram", "matrix"] as const) {
      const f = await fixture();
      await prisma.conversation.update({ where: { id: f.input.conversationId }, data: { sourceChannel: channel } });
      await prisma.conversationChannelBinding.create({ data: { conversationId: f.input.conversationId, kind: channel === "telegram" ? "TELEGRAM" : "MATRIX", externalConversationId: `synthetic-${channel}` } });
      const row = await createServiceRequest(f.input);
      await resolveServiceRequest(f.ownerActor, row.id, "accepted");
      const notification = await prisma.serviceRequestNotification.findUniqueOrThrow({ where: { requestId: row.id } });
      await flushServiceRequestNotification(notification.id);
      const prepared = await prisma.serviceRequestNotification.findUniqueOrThrow({ where: { id: notification.id } });
      expect(prepared.status).toBe("queued");
      const outbox = await prisma.outboxEvent.findUniqueOrThrow({ where: { idempotencyKey: `conversation.message.requested:${prepared.messageId}` } });
      expect((outbox.payload as { channel: string }).channel).toBe(channel);
    }
  });
  it("publishes the defined boundary snapshot and keeps later drafts isolated", async () => {
    const f = await fixture();
    await prisma.representative.update({ where: { id: f.visitor.representativeId }, data: { publicMode: true, humanInLoop: false } });
    const rules = { version: 1 as const, boundaries: ["appointment", "discount", "scope", "dispute", "human"].map(id => ({ id, request: "", action: "approve" as const })) };
    await setServiceBoundaryDraft(f.ownerActor, rules);
    await prisma.knowledgePack.update({ where: { representativeId: f.visitor.representativeId }, data: { faq: [{ id: "synthetic", title: "FAQ", kind: "faq", summary: "Synthetic public fact" }] } });
    const rep = await prisma.representative.findUniqueOrThrow({ where: { id: f.visitor.representativeId } });
    const version = await publishRepresentativeVersion({ representativeSlug: rep.slug, ownerId: rep.ownerId, publishedBy: rep.ownerId });
    expect((await readPublishedServiceBoundaries(rep.id, version.id))!.boundaries[1]!.action).toBe("approve");
    await setServiceBoundaryDraft(f.ownerActor, { ...rules, boundaries: rules.boundaries.map(rule => ({ ...rule, action: "decline" })) });
    expect((await readPublishedServiceBoundaries(rep.id, version.id))!.boundaries[1]!.action).toBe("approve");
  });
  it("creates idempotently and rejects conflicting reuse", async () => {
    const f = await fixture(); const first = await createServiceRequest(f.input);
    expect((await createServiceRequest(f.input)).id).toBe(first.id);
    await expect(createServiceRequest({ ...f.input, content: "不同请求" })).rejects.toThrow("idempotency_conflict");
  });
  it("allows only one concurrent decision and keeps terminal records immutable", async () => {
    const f = await fixture(); const row = await createServiceRequest(f.input);
    const results = await Promise.allSettled([resolveServiceRequest(f.ownerActor, row.id, "accepted"), resolveServiceRequest(f.visitor, row.id, "withdraw")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    await expect(prisma.serviceRequest.update({ where: { id: row.id }, data: { content: "改写" } })).rejects.toThrow();
    await expect(prisma.serviceRequest.delete({ where: { id: row.id } })).rejects.toThrow();
  });
  it("immediately disables the old request and preserves a three-node reply chain", async () => {
    const f = await fixture(); const first = await createServiceRequest(f.input);
    const base = { content: "数量多少", summary: "追问数量", ruleIds: ["discount"], kind: "discount", representativeVersionId: f.version.id, options: [{ id: "other", label: "其他" }], reply: { action: "follow_up", text: "数量多少" }, idempotencyKey: "follow-up" };
    const second = await createServiceRequestSuccessor({ ...base, actor: f.ownerActor, parentId: first.id, mode: "follow_up" });
    expect((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("disabled");
    const third = await createServiceRequestSuccessor({ ...base, actor: f.visitor, parentId: second.id, mode: "answer", content: "100份申请八折", reply: { action: "answer", text: "100份" }, idempotencyKey: "answer" });
    const chain = await getServiceRequestChain(f.visitor, third.id);
    expect(chain.items.map(item => item.id)).toEqual([first.id, second.id, third.id]);
    const page = await getServiceRequestChain(f.visitor, third.id, 0, 2);
    expect(page.nextOffset).toBe(2);
    expect((await getServiceRequestChain(f.visitor, third.id, page.nextOffset!, 2)).items.map(item => item.id)).toEqual([third.id]);
    expect(chain.items[1]!.reply).toEqual({ action: "answer", text: "100份" });
    expect(Object.keys(chain.items[0]!).sort()).toEqual(["content", "id", "parentId", "reply"]);
  });
  it("rolls back parent disabling if successor insertion fails", async () => {
    const f = await fixture(); const first = await createServiceRequest(f.input);
    await expect(createServiceRequestSuccessor({ actor: f.ownerActor, parentId: first.id, mode: "follow_up", content: "问题", summary: "问题", ruleIds: ["discount"], kind: "discount", representativeVersionId: f.version.id, options: [], reply: {}, idempotencyKey: f.input.idempotencyKey })).rejects.toThrow();
    expect((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("pending");
  });
  it("keeps a decision committed when channel notification preparation fails", async () => {
    const f = await fixture(); const row = await createServiceRequest(f.input);
    await resolveServiceRequest(f.ownerActor, row.id, "accepted", "同意");
    const notification = await prisma.serviceRequestNotification.findUniqueOrThrow({ where: { requestId: row.id } });
    expect((await flushServiceRequestNotification(notification.id)).status).toBe("retrying");
    expect((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("accepted");
    expect((await prisma.serviceRequestNotification.findUniqueOrThrow({ where: { id: notification.id } })).messageId).toBeNull();
  });
  it("queues web notifications once through the existing durable message outbox", async () => {
    const f = await fixture();
    await prisma.conversation.update({ where: { id: f.input.conversationId }, data: { sourceChannel: "web" } });
    const row = await createServiceRequest(f.input);
    await resolveServiceRequest(f.ownerActor, row.id, "rejected", "暂不提供");
    const notification = await prisma.serviceRequestNotification.findUniqueOrThrow({ where: { requestId: row.id } });
    await Promise.all([flushServiceRequestNotification(notification.id), flushServiceRequestNotification(notification.id)]);
    const result = await prisma.serviceRequestNotification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(result.status).toBe("queued");
    expect(await prisma.message.count({ where: { conversationId: f.input.conversationId, senderType: "SYSTEM" } })).toBe(1);
  });
  it("isolates visitors and retains disabled requests in lists", async () => {
    const f = await fixture(); const row = await createServiceRequest(f.input);
    await resolveServiceRequest(f.visitor, row.id, "withdraw");
    expect((await listServiceRequests(f.visitor)).items[0]!.status).toBe("disabled");
    await expect(getServiceRequestChain({ ...f.visitor, role: "visitor", contactId: "someone-else", audienceIdentityId: null }, row.id)).rejects.toThrow("not_found");
  });
});
