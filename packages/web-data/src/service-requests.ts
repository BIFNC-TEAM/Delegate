import { createHash } from "node:crypto";
import { Prisma, type ServiceRequest } from "@prisma/client";
import { createOrReuseHandoffRequestInTransaction } from "./handoff-entitlements";
import { prisma } from "./prisma";
import { ServiceRequestError, publishedServiceBoundariesSchema, resolveServiceBoundaryAction, serviceRequestItemSchema } from "./service-request-contract";

// Constructed only by authenticated host adapters, never from model arguments.
export type ServiceRequestActor =
  | { role: "owner"; ownerId: string; representativeId: string }
  | { role: "visitor"; contactId: string; audienceIdentityId: string | null; representativeId: string };
type Tx = Prisma.TransactionClient;
const json = (value: unknown) => value as Prisma.InputJsonValue;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function authorizeServiceRequestActor(tx: Tx, actor: ServiceRequestActor) {
  const representative = await tx.representative.findUnique({ where: { id: actor.representativeId }, select: { ownerId: true } });
  if (!representative || (actor.role === "owner" && representative.ownerId !== actor.ownerId)) throw new ServiceRequestError("forbidden", 403);
}
async function requireRegisteredVisitor(tx: Tx, actor: ServiceRequestActor) {
  if (actor.role !== "visitor") return;
  const identity = actor.audienceIdentityId ? await tx.audienceIdentity.findFirst({ where: {
    id: actor.audienceIdentityId, status: "REGISTERED", mergedIntoId: null,
    account: { status: "ACTIVE", authIdentities: { some: { status: "ACTIVE" } } },
  }, select: { id: true } }) : null;
  if (!identity) throw new ServiceRequestError("authentication_required", 401);
}
function visible(actor: ServiceRequestActor): Prisma.ServiceRequestWhereInput {
  return actor.role === "owner"
    ? { ownerId: actor.ownerId, ...(actor.representativeId ? { representativeId: actor.representativeId } : {}) }
    : { representativeId: actor.representativeId, ...(actor.audienceIdentityId
      ? { audienceIdentityId: actor.audienceIdentityId } : { contactId: actor.contactId, audienceIdentityId: null }) };
}
async function get(tx: Tx, actor: ServiceRequestActor, id: string) {
  if (actor.role === "visitor") await authorizeServiceRequestActor(tx, actor);
  const row = await tx.serviceRequest.findFirst({ where: { ...visible(actor), id } });
  if (!row) throw new ServiceRequestError("not_found", 404);
  return row;
}
function recipient(actor: ServiceRequestActor, row: ServiceRequest) {
  return actor.role === "owner" ? row.direction === "visitor_to_owner" : row.direction === "owner_to_visitor";
}
export async function getServiceRequest(actor: ServiceRequestActor, id: string) {
  return prisma.$transaction(async tx => {
    const row = await get(tx, actor, id);
    const notification = await tx.serviceRequestNotification.findUnique({ where: { requestId: row.id } });
    const message = notification?.messageId ? await tx.message.findUnique({ where: { id: notification.messageId }, select: { deliveryStatus: true } }) : null;
    return { ...row, notification: notification ? { status: message?.deliveryStatus?.toLowerCase() ?? notification.status, preparationStatus: notification.status } : null };
  });
}
export async function createServiceRequest(input: {
  actor: ServiceRequestActor; conversationId: string; representativeVersionId: string;
  kind: string; content: string; summary: string; ruleIds: string[]; idempotencyKey: string;
}) {
  if (input.actor.role !== "visitor") throw new ServiceRequestError("forbidden", 403);
  return prisma.$transaction(async tx => {
    await authorizeServiceRequestActor(tx, input.actor);
    await requireRegisteredVisitor(tx, input.actor);
    const conversation = await tx.conversation.findFirst({ where: {
      id: input.conversationId, representativeId: input.actor.representativeId,
      contactId: input.actor.role === "visitor" ? input.actor.contactId : "",
      audienceIdentityId: input.actor.role === "visitor" ? input.actor.audienceIdentityId : null,
    } });
    const version = await tx.representativeVersion.findFirst({ where: { id: input.representativeVersionId, representativeId: input.actor.representativeId } });
    if (!conversation || !version) throw new ServiceRequestError("forbidden", 403);
    const item = serviceRequestItemSchema.omit({ itemId: true }).safeParse({ content: input.content, summary: input.summary, ruleIds: input.ruleIds });
    if (!item.success || !input.idempotencyKey || input.idempotencyKey.length > 250) throw new ServiceRequestError("invalid_request", 400);
    const snapshot = version.snapshot as { knowledge?: { serviceBoundaries?: unknown } };
    const rules = publishedServiceBoundariesSchema.safeParse(snapshot.knowledge?.serviceBoundaries);
    if (!rules.success || resolveServiceBoundaryAction(rules.data, input.ruleIds) !== "approve") throw new ServiceRequestError("request_not_permitted", 403);
    const episode = conversation.activeEpisodeId ? await tx.conversationEpisode.findUnique({ where: { id: conversation.activeEpisodeId } }) : null;
    if (!episode || episode.representativeVersionId !== version.id) throw new ServiceRequestError("version_conflict", 409);
    const owner = await tx.representative.findUniqueOrThrow({ where: { id: input.actor.representativeId }, select: { ownerId: true } });
    const payloadHash = hash([input.kind, input.content, input.summary, input.ruleIds, input.representativeVersionId]);
    const row = await tx.serviceRequest.upsert({
      where: { conversationId_idempotencyKey: { conversationId: input.conversationId, idempotencyKey: input.idempotencyKey } },
      update: {},
      create: { ownerId: owner.ownerId, representativeId: input.actor.representativeId, conversationId: input.conversationId,
        contactId: conversation.contactId, audienceIdentityId: conversation.audienceIdentityId,
        representativeVersionId: input.representativeVersionId, direction: "visitor_to_owner", kind: input.kind,
        content: input.content, summary: input.summary, ruleIds: input.ruleIds, options: [],
        idempotencyKey: input.idempotencyKey, payloadHash },
    });
    if (row.payloadHash !== payloadHash) throw new ServiceRequestError("idempotency_conflict", 409);
    return row;
  });
}
export async function resolveServiceRequest(actor: ServiceRequestActor, id: string, action: "accepted" | "rejected" | "withdraw", text = "") {
  return prisma.$transaction(async tx => {
    const row = await get(tx, actor, id);
    const withdrawing = action === "withdraw";
    if (withdrawing ? recipient(actor, row) : actor.role !== "owner" || !recipient(actor, row)) throw new ServiceRequestError("forbidden", 403);
    if (row.status !== "pending") throw new ServiceRequestError("state_conflict", 409);
    const result = await tx.serviceRequest.updateMany({ where: { id, status: "pending" }, data: {
      status: withdrawing ? "disabled" : action, disabledReason: withdrawing ? "withdrawn" : null,
      resolvedAt: new Date(), ...(withdrawing ? {} : { reply: { action, text } }),
    } });
    if (result.count !== 1) throw new ServiceRequestError("state_conflict", 409);
    if (!withdrawing) await tx.serviceRequestNotification.create({ data: { requestId: row.id, conversationId: row.conversationId, text: `你的服务申请（${row.summary.slice(0, 80)}）：${action === "accepted" ? "owner已接受" : "owner已拒绝"}${text ? `。${text}` : ""}` } });
    return { ...await tx.serviceRequest.findUniqueOrThrow({ where: { id } }), notification: withdrawing ? null : { status: "pending" } };
  });
}
export async function createServiceRequestSuccessor(input: {
  actor: ServiceRequestActor; parentId: string; mode: "follow_up" | "answer" | "replace";
  content: string; summary: string; ruleIds: string[]; kind: string; representativeVersionId: string;
  options: Array<{ id: string; label: string }>; reply: unknown; idempotencyKey: string;
  generateOptions?: (question: string) => Promise<Array<{ id: string; label: string }>>;
}) {
  // Generate outside the write transaction, and never regenerate for an existing successor.
  if (input.mode === "follow_up" && input.generateOptions) {
    const parent = await prisma.$transaction(tx => get(tx, input.actor, input.parentId));
    if (input.actor.role !== "owner" || !recipient(input.actor, parent)) throw new ServiceRequestError("forbidden", 403);
    const existing = await prisma.serviceRequest.findUnique({ where: { parentId: input.parentId } });
    if (!existing) input = { ...input, options: [...(await input.generateOptions(input.content)).filter(option => option.id !== "other"), { id: "other", label: "其他" }] };
  }
  return prisma.$transaction(async tx => {
    await requireRegisteredVisitor(tx, input.actor);
    if (!input.idempotencyKey || input.idempotencyKey.length > 250) throw new ServiceRequestError("invalid_request", 400);
    const parent = await get(tx, input.actor, input.parentId);
    const payloadHash = hash([input.mode, input.content, input.summary, input.ruleIds, input.kind, input.representativeVersionId, ...(input.mode === "follow_up" ? [] : [input.options]), input.reply]);
    const prior = await tx.serviceRequest.findUnique({ where: { parentId: parent.id } });
    if (prior && prior.idempotencyKey === input.idempotencyKey) {
      if (prior.payloadHash !== payloadHash) throw new ServiceRequestError("idempotency_conflict", 409);
      return prior;
    }
    if (parent.status !== "pending") throw new ServiceRequestError("state_conflict", 409);
    const canReceive = recipient(input.actor, parent);
    if (input.mode === "follow_up" ? input.actor.role !== "owner" || !canReceive
      : input.mode === "answer" ? input.actor.role !== "visitor" || !canReceive
      : canReceive || input.actor.role !== "visitor") throw new ServiceRequestError("forbidden", 403);
    const version = await tx.representativeVersion.findFirst({ where: { id: input.representativeVersionId, representativeId: parent.representativeId } });
    if (!version) throw new ServiceRequestError("invalid_version", 400);
    if (!input.content.trim() || input.content.length > 8000 || !input.summary.trim() || input.summary.length > 2000) throw new ServiceRequestError("invalid_request", 400);
    if (input.mode !== "follow_up") {
      const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: parent.conversationId } });
      const episode = conversation.activeEpisodeId ? await tx.conversationEpisode.findUnique({ where: { id: conversation.activeEpisodeId } }) : null;
      if (episode?.representativeVersionId !== version.id) throw new ServiceRequestError("version_conflict", 409);
      const rules = publishedServiceBoundariesSchema.safeParse((version.snapshot as { knowledge?: { serviceBoundaries?: unknown } }).knowledge?.serviceBoundaries);
      if (!rules.success || resolveServiceBoundaryAction(rules.data, input.ruleIds) !== "approve") throw new ServiceRequestError("request_not_permitted", 403);
    }

    const result = await tx.serviceRequest.updateMany({ where: { id: parent.id, status: "pending" }, data: {
      status: "disabled", disabledReason: input.mode === "replace" ? "superseded" : "follow_up", resolvedAt: new Date(),
      ...(input.mode === "replace" ? {} : { reply: json(input.reply) }),
    } });
    if (result.count !== 1) throw new ServiceRequestError("state_conflict", 409);
    const successor = await tx.serviceRequest.create({ data: {
      ownerId: parent.ownerId, representativeId: parent.representativeId, conversationId: parent.conversationId, contactId: parent.contactId,
      audienceIdentityId: parent.audienceIdentityId, representativeVersionId: input.representativeVersionId,
      direction: input.mode === "follow_up" ? "owner_to_visitor" : "visitor_to_owner", parentId: parent.id,
      kind: input.kind, content: input.content, summary: input.summary, ruleIds: input.ruleIds,
      options: json(input.options), idempotencyKey: input.idempotencyKey, payloadHash,
    } });
    if (input.mode === "follow_up") await tx.serviceRequestNotification.create({ data: { requestId: successor.id, conversationId: parent.conversationId,
      text: `owner请求补充信息：${input.content}\n${input.options.map(option => `${option.id}: ${option.label}`).join("\n")}` } });
    return { ...successor, notification: input.mode === "follow_up" ? { status: "pending" } : null };
  });
}
export async function listServiceRequests(actor: ServiceRequestActor, input: {
  box?: "sent" | "received" | "all"; contactId?: string; kind?: string; status?: string;
  from?: Date; to?: Date; ascending?: boolean; cursor?: string; limit?: number;
} = {}) {
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const from = input.from ?? new Date(Date.now() - 365 * 86400000);
  const to = input.to ?? new Date();
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) throw new ServiceRequestError("invalid_time_range", 400);
  return prisma.$transaction(async tx => {
    if (actor.role === "visitor") await authorizeServiceRequestActor(tx, actor);
    const sentDirection = actor.role === "owner" ? "owner_to_visitor" : "visitor_to_owner";
    const direction = input.box && input.box !== "all" ? (input.box === "sent" ? sentDirection : sentDirection === "visitor_to_owner" ? "owner_to_visitor" : "visitor_to_owner") : undefined;
    const where: Prisma.ServiceRequestWhereInput = { ...visible(actor),
      ...(input.contactId ? { AND: [{ contactId: input.contactId }] } : {}),
      ...(direction ? { direction } : {}), ...(input.kind ? { kind: input.kind } : {}), ...(input.status ? { status: input.status } : {}),
      createdAt: { gte: from, lte: to } };
    if (input.cursor && !await tx.serviceRequest.findFirst({ where: { ...where, id: input.cursor } })) throw new ServiceRequestError("invalid_cursor", 400);
    const order = input.ascending ? "asc" : "desc";
    const rows = await tx.serviceRequest.findMany({ where, orderBy: [{ createdAt: order }, { id: order }], take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}) });
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
  });
}
export async function getServiceRequestChain(actor: ServiceRequestActor, id: string, offset = 0, limit = 25) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ServiceRequestError("invalid_pagination", 400);
  return prisma.$transaction(async tx => {
    // Recursive SQL is fixed by the host, never model/user-provided SQL.
    const root = await get(tx, actor, id);
    const rows = await tx.$queryRaw<Array<{ id: string; parentId: string | null; content: string; reply: Prisma.JsonValue | null; depth: number }>>`
      WITH RECURSIVE chain AS (
        SELECT id, "parentId", content, reply, 0 AS depth FROM "ServiceRequest" WHERE id = ${id}
        UNION ALL SELECT p.id, p."parentId", p.content, p.reply, c.depth + 1
        FROM "ServiceRequest" p JOIN chain c ON p.id = c."parentId"
        WHERE p."representativeId" = ${root.representativeId} AND p."ownerId" = ${root.ownerId}
      ) SELECT * FROM chain ORDER BY depth DESC OFFSET ${offset} LIMIT ${limit + 1}`;
    return { items: rows.slice(0, limit).map(({ depth: _depth, ...row }) => row), nextOffset: rows.length > limit ? offset + limit : null };
  });
}

export async function getServiceRequestOwnerActor(slug: string, ownerId: string): Promise<ServiceRequestActor> {
  const representative = await prisma.representative.findFirst({ where: { slug }, select: { id: true } });
  if (!representative) throw new ServiceRequestError("not_found", 404);
  return { role: "owner", ownerId, representativeId: representative.id };
}
export async function getServiceRequestVisitorContext(slug: string, audienceIdentityId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({ where: {
    id: conversationId, audienceIdentityId, representative: { slug },
  }, include: { representative: { select: { id: true } }, episodes: false } });
  if (!conversation) throw new ServiceRequestError("not_found", 404);
  const episode = conversation.activeEpisodeId ? await prisma.conversationEpisode.findUnique({ where: { id: conversation.activeEpisodeId } }) : null;

  return { actor: { role: "visitor" as const, representativeId: conversation.representativeId, contactId: conversation.contactId,
    audienceIdentityId }, conversationId: conversation.id, ...(episode?.representativeVersionId ? { representativeVersionId: episode.representativeVersionId } : {}) };
}
export async function setServiceBoundaryDraft(actor: ServiceRequestActor, value: unknown) {
  if (actor.role !== "owner") throw new ServiceRequestError("forbidden", 403);
  const parsed = publishedServiceBoundariesSchema.safeParse(value);
  if (!parsed.success) throw new ServiceRequestError("invalid_rules", 400);
  return prisma.$transaction(async tx => {
    await authorizeServiceRequestActor(tx, actor);
    const representative = await tx.representative.findUniqueOrThrow({ where: { id: actor.representativeId }, select: { roleSummary: true } });
    return tx.knowledgePack.upsert({ where: { representativeId: actor.representativeId },
      update: { serviceBoundaries: json(parsed.data) },
      create: { representativeId: actor.representativeId, identitySummary: representative.roleSummary, faq: [], materials: [], policies: [], serviceBoundaries: json(parsed.data) },
      select: { serviceBoundaries: true } });
  });
}

export async function createServiceRequestBatch(context: {
  actor: ServiceRequestActor; conversationId: string; representativeVersionId: string;
}, value: unknown) {
  const { validateServiceRequestBatch } = await import("./service-request-contract");
  const batch = validateServiceRequestBatch(value);
  await prisma.$transaction(async tx => {
    await authorizeServiceRequestActor(tx, context.actor);
    if (context.actor.role !== "visitor") throw new ServiceRequestError("forbidden", 403);
    await requireRegisteredVisitor(tx, context.actor);
    const message = await tx.message.findFirst({ where: { id: batch.messageId, conversationId: context.conversationId, senderType: "AUDIENCE",
      conversation: { representativeId: context.actor.representativeId, contactId: context.actor.contactId, audienceIdentityId: context.actor.audienceIdentityId } } });
    if (!message) throw new ServiceRequestError("invalid_source_message", 403);
    const payloadHash = hash(batch);
    const reservation = await tx.serviceRequestBatch.upsert({ where: { messageId: batch.messageId }, update: {},
      create: { id: hash([context.conversationId, batch.messageId]), conversationId: context.conversationId, messageId: batch.messageId, payloadHash } });
    if (reservation.payloadHash !== payloadHash) throw new ServiceRequestError("batch_manifest_conflict", 409);
  });
  const results = [];
  for (const item of batch.items) {
    try {
      const rules = await readPublishedServiceBoundaries(context.actor.representativeId, context.representativeVersionId);
      if (!rules) throw new ServiceRequestError("request_not_permitted", 403);
      const action = resolveServiceBoundaryAction(rules, item.ruleIds);
      if (action === "decline") {
        results.push({ itemId: item.itemId, status: "declined" });
      } else if (action === "handoff") {
        if (context.actor.role !== "visitor") throw new ServiceRequestError("forbidden", 403);
        const result = await prisma.$transaction(async tx => {
          await authorizeServiceRequestActor(tx, context.actor);
          const conversation = await tx.conversation.findFirst({ where: { id: context.conversationId,
            representativeId: context.actor.representativeId,
            contactId: context.actor.role === "visitor" ? context.actor.contactId : "",
            audienceIdentityId: context.actor.role === "visitor" ? context.actor.audienceIdentityId : null } });
          const episode = conversation?.activeEpisodeId ? await tx.conversationEpisode.findUnique({ where: { id: conversation.activeEpisodeId } }) : null;
          if (!conversation || episode?.representativeVersionId !== context.representativeVersionId) throw new ServiceRequestError("version_conflict", 409);
          return createOrReuseHandoffRequestInTransaction({ representativeId: context.actor.representativeId,
            contactId: conversation.contactId, conversationId: conversation.id, episodeId: episode.id,
            reason: item.ruleIds.join(","), summary: item.summary, recommendedPriority: 0,
            recommendedOwnerAction: "Review the visitor service boundary request" }, tx);
        });
        results.push({ itemId: item.itemId, status: result.outcome, handoffId: result.request?.id ?? null });
      } else {
        const request = await createServiceRequest({ ...context, ...item, kind: item.ruleIds[0]!, idempotencyKey: `${batch.messageId}:${item.itemId}` });
        results.push({ itemId: item.itemId, status: "created", request });
      }
    } catch (error) {
      results.push({ itemId: item.itemId, status: "failed", code: error instanceof ServiceRequestError ? error.code : "service_unavailable" });
    }
  }
  return { results };
}

export async function readPublishedServiceBoundaries(representativeId: string, versionId: string) {
  const version = await prisma.representativeVersion.findFirst({ where: { id: versionId, representativeId } });
  const value = (version?.snapshot as { knowledge?: { serviceBoundaries?: unknown } } | null)?.knowledge?.serviceBoundaries;
  if (value === undefined) return null;
  const parsed = publishedServiceBoundariesSchema.safeParse(value);
  if (!parsed.success) throw new ServiceRequestError("invalid_published_rules", 409);
  return parsed.data;
}

export async function getServiceBoundaryDraft(actor: ServiceRequestActor) {
  if (actor.role !== "owner") throw new ServiceRequestError("forbidden", 403);
  return prisma.$transaction(async tx => {
    await authorizeServiceRequestActor(tx, actor);
    const pack = await tx.knowledgePack.findUnique({ where: { representativeId: actor.representativeId }, select: { serviceBoundaries: true } });
    return { serviceBoundaries: pack?.serviceBoundaries ?? null };
  });
}
