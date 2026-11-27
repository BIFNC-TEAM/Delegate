import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { fixture as historyFixture, nextRun } from "./citation-postgres-fixture";
import { createAgentContextAuthorization } from "../src/agent-context-authorization";
import { loadSafeCitationHistory } from "../src/citation-history";
import { completeInlineGenerationRun, publishRepresentativeVersion } from "../src/conversation-platform";
import { setServiceBoundaryDraft, readPublishedServiceBoundaries } from "../src/service-requests";
import { flushServiceRequestNotification } from "../src/service-request-notifications";
import { prisma } from "../src/prisma";
import { createServiceRequestBatch, createServiceRequest, createServiceRequestSuccessor, resolveServiceRequest, getServiceRequestChain, listServiceRequests, type ServiceRequestActor } from "../src/service-requests";
const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/none");
const enabled = process.env.DELEGATE_SERVICE_REQUEST_E2E === "1" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname.endsWith("_test");
async function fixture(actions: Record<string, string> = {}) {
  const owner = await prisma.owner.create({ data: { displayName: "Synthetic c007 owner" } });
  const rep = await prisma.representative.create({ data: { ownerId: owner.id, slug: `c007-${randomUUID()}`, displayName: "Synthetic", roleSummary: "Assistant", tone: "neutral", languages: ["zh"], freeScope: [], paywalledIntents: [], handoffPrompt: "Help", allowedSkills: [], actionGate: {} } });
  const account = await prisma.account.create({ data: { authIdentities: { create: { provider: "LOGTO", issuer: "https://synthetic.invalid", subject: randomUUID(), verifiedAt: new Date(), lastAuthenticatedAt: new Date() } } } });
  const audience = await prisma.audienceIdentity.create({ data: { audienceKey: randomUUID(), status: "REGISTERED", accountId: account.id } });
  const contact = await prisma.contact.create({ data: { audienceIdentityId: audience.id, representativeId: rep.id, sourceChannel: "telegram" } });
  const conversation = await prisma.conversation.create({ data: { audienceIdentityId: audience.id, representativeId: rep.id, contactId: contact.id, channel: "PRIVATE_CHAT", sourceChannel: "telegram" } });
  const rules = ["appointment", "discount", "scope", "dispute", "human"].map(id => ({ id, request: "", action: actions[id] ?? "approve" }));
  const version = await prisma.representativeVersion.create({ data: { representativeId: rep.id, versionNumber: 1, status: "PUBLISHED", snapshot: { knowledge: { serviceBoundaries: { version: 1, boundaries: rules } } } } });
  const episode = await prisma.conversationEpisode.create({ data: { conversationId: conversation.id, representativeVersionId: version.id, sequence: 1 } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { activeEpisodeId: episode.id } });
  const visitor: ServiceRequestActor = { role: "visitor", representativeId: rep.id, contactId: contact.id, audienceIdentityId: audience.id };
  const ownerActor: ServiceRequestActor = { role: "owner", representativeId: rep.id, ownerId: owner.id };
  const input = { actor: visitor, conversationId: conversation.id, representativeVersionId: version.id, content: "申请八折", summary: "八折", ruleIds: ["discount"], kind: "discount", idempotencyKey: "message:1" };
  return { input, visitor, ownerActor, version };
}
afterAll(async () => { if (enabled) await prisma.$disconnect(); });
// Hold the parent until both calls reach a conflicting write/row lock. This
// reproduces the former read-before-write race without relying on a fixed delay.
async function raceOnParent<T>(parentId: string, operations: [() => Promise<T>, () => Promise<T>]) {
  let release!: () => void;
  let ready!: () => void;
  const locked = new Promise<void>(resolve => { ready = resolve; });
  const unlock = new Promise<void>(resolve => { release = resolve; });
  const holder = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ServiceRequest" WHERE id = ${parentId} FOR UPDATE`;
    ready();
    await unlock;
  });
  try {
    await Promise.race([locked, holder.then(() => { throw new Error("Parent lock ended early"); })]);
    const pending = Promise.allSettled(operations.map(operation => operation()));
    try {
      const deadline = Date.now() + 2500;
      let waiters = 0;
      while (Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%"ServiceRequest"%'`;
        waiters = row!.count;
        if (waiters >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiters).toBeGreaterThanOrEqual(2);
    } finally { release(); }
    return await pending;
  } finally {
    release();
    await holder;
  }
}
describe.skipIf(!enabled)("PostgreSQL service requests", () => {
  it.each(["follow_up", "answer", "replace"] as const)("returns one saved successor for concurrent identical %s retries", async mode => {
    const f = await fixture();
    const first = await createServiceRequest(f.input);
    const base = { content: "数量多少", summary: "追问数量", ruleIds: ["discount"], kind: "discount", representativeVersionId: f.version.id,
      options: [{ id: "other", label: "其他" }], reply: { action: "follow_up", text: "数量多少" }, idempotencyKey: "follow-up" };
    const parent = mode === "answer" ? await createServiceRequestSuccessor({ ...base, actor: f.ownerActor, parentId: first.id, mode: "follow_up" }) : first;
    let generation = 0;
    const args = { ...base, actor: mode === "follow_up" ? f.ownerActor : f.visitor, parentId: parent.id, mode, idempotencyKey: `retry-${mode}`,
      ...(mode === "follow_up" ? { generateOptions: async () => [{ id: "choice", label: `模型选项${++generation}` }] }
        : { content: "100份申请八折", reply: { action: "answer", text: "100份" } }) };
    const results = await raceOnParent(parent.id, [() => createServiceRequestSuccessor(args), () => createServiceRequestSuccessor(args)]);
    expect(results.every(result => result.status === "fulfilled")).toBe(true);
    const rows = results.map(result => { if (result.status === "rejected") throw result.reason; return result.value; });
    expect(rows[0]!.id).toBe(rows[1]!.id);
    expect(rows[0]!.options).toEqual(rows[1]!.options);
    expect(await prisma.serviceRequest.count({ where: { parentId: parent.id } })).toBe(1);
    expect(await prisma.serviceRequestNotification.count({ where: { requestId: rows[0]!.id } })).toBe(mode === "follow_up" ? 1 : 0);
  });
  it.each(["different_input", "different_key"] as const)("keeps concurrent %s successor attempts conflicting", async variant => {
    const f = await fixture();
    const parent = await createServiceRequest(f.input);
    const args = { actor: f.ownerActor, parentId: parent.id, mode: "follow_up" as const, content: "几点？", summary: "时间", kind: "discount",
      ruleIds: ["discount"], representativeVersionId: f.version.id, options: [], reply: { action: "follow_up", text: "几点？" }, idempotencyKey: "same" };
    const other = variant === "different_input" ? { ...args, content: "多少份？" } : { ...args, idempotencyKey: "other" };
    const results = await raceOnParent(parent.id, [() => createServiceRequestSuccessor(args), () => createServiceRequestSuccessor(other)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe(variant === "different_input" ? "idempotency_conflict" : "state_conflict");
    expect(await prisma.serviceRequest.count({ where: { parentId: parent.id } })).toBe(1);
  });
  it.each(["accepted", "withdraw"] as const)("allows only one conversion when a successor races with %s", async action => {
    const f = await fixture();
    const parent = await createServiceRequest(f.input);
    const args = { actor: f.ownerActor, parentId: parent.id, mode: "follow_up" as const, content: "几点？", summary: "时间", kind: "discount",
      ruleIds: ["discount"], representativeVersionId: f.version.id, options: [], reply: { action: "follow_up", text: "几点？" }, idempotencyKey: "follow-up" };
    const results = await raceOnParent(parent.id, [() => createServiceRequestSuccessor(args),
      () => resolveServiceRequest(action === "accepted" ? f.ownerActor : f.visitor, parent.id, action)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("state_conflict");
    const saved = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: parent.id } });
    const successorCount = await prisma.serviceRequest.count({ where: { parentId: parent.id } });
    expect(successorCount).toBe(saved.disabledReason === "follow_up" ? 1 : 0);
    expect(saved.status).not.toBe("pending");
  });
  it("persists UI actions separately while projecting only text to subsequent model history", async () => {
    const f = await historyFixture();
    await createAgentContextAuthorization(f.input);
    const output = await completeInlineGenerationRun({ ...f.input, conversationId: f.conversationId, replyText: "请登录后确认提交", senderDisplayName: "Synthetic", countUsage: false, completeOutbox: false, suggestedActions: [{ type: "login" }] });
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: output.message.id } });
    expect(stored.content).toMatchObject({ suggestedActions: [{ type: "login" }] });
    const current = await nextRun(f);
    const safe = await loadSafeCitationHistory({ ...current.input, byteBudget: 20000 });
    expect(safe.messages[1]!.text).toBe("请登录后确认提交");
    expect(JSON.stringify(safe.messages)).not.toContain("suggestedActions");
    expect(JSON.stringify(safe.messages)).not.toContain('"login"');
  });
  it("blocks anonymous and suspended accounts before application writes", async () => {
    const f = await fixture();
    await expect(createServiceRequest({ ...f.input, actor: { ...f.visitor, audienceIdentityId: null } })).rejects.toThrow("authentication_required");
    const identity = await prisma.audienceIdentity.findUniqueOrThrow({ where: { id: f.visitor.role === "visitor" ? f.visitor.audienceIdentityId! : "" } });
    await prisma.account.update({ where: { id: identity.accountId! }, data: { status: "SUSPENDED" } });
    await expect(createServiceRequest(f.input)).rejects.toThrow("authentication_required");
    expect(await prisma.serviceRequest.count({ where: { conversationId: f.input.conversationId } })).toBe(0);
  });
  it("uses frozen owner scope for aggregate/detail and successor even after representative transfer", async () => {
    const f = await fixture();
    const row = await createServiceRequest(f.input);
    const other = await prisma.owner.create({ data: { displayName: "Other synthetic owner" } });
    await prisma.representative.update({ where: { id: row.representativeId }, data: { ownerId: other.id } });
    expect((await listServiceRequests({ ...f.ownerActor, representativeId: "" }, { box: "all" })).items.some(item => item.id === row.id)).toBe(true);
    expect((await listServiceRequests({ role: "owner", ownerId: other.id, representativeId: "" })).items.some(item => item.id === row.id)).toBe(false);
    const generateOptions = async () => [{ id: "yes", label: "是" }];
    const args = { actor: f.ownerActor, parentId: row.id, mode: "follow_up" as const, content: "几点？", summary: "时间", kind: "discount", ruleIds: ["discount"], representativeVersionId: row.representativeVersionId, options: [], reply: { action: "follow_up", text: "几点？" }, idempotencyKey: "x".repeat(250), generateOptions };
    const follow = await createServiceRequestSuccessor(args);
    const replay = await createServiceRequestSuccessor({ ...args, generateOptions: async () => { throw new Error("must not regenerate"); } });
    expect(replay.id).toBe(follow.id);
    expect(follow.ownerId).toBe(row.ownerId);
    await expect(createServiceRequestSuccessor({ ...args, content: "改问题" })).rejects.toThrow("idempotency_conflict");
    expect((await listServiceRequests({ ...f.ownerActor, representativeId: "" }, { box: "sent" })).items.some(item => item.id === follow.id)).toBe(true);
  });
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
