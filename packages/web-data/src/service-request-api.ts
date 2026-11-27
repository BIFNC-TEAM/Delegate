import { z } from "zod";
import { ServiceRequestError, serviceRequestItemSchema } from "./service-request-contract";
import { createServiceRequestBatch, createServiceRequestSuccessor, getServiceRequest, getServiceRequestChain,
  getServiceBoundaryDraft, listServiceRequests, resolveServiceRequest, setServiceBoundaryDraft, type ServiceRequestActor } from "./service-requests";
const id = z.string().min(1).max(200);
const text = z.string().max(8000);
const operationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), batch: z.unknown() }).strict(),
  z.object({ operation: z.literal("resolve"), id, action: z.enum(["accepted", "rejected", "withdraw"]), text: text.default("") }).strict(),
  z.object({ operation: z.literal("successor"), id, mode: z.enum(["follow_up", "answer", "replace"]), idempotencyKey: z.string().min(1).max(250),
    item: serviceRequestItemSchema, options: z.array(z.object({ id, label: z.string().min(1).max(500) }).strict()).max(10).default([]),
    reply: z.object({ selectedOptionId: id.optional(), text: text.optional() }).strict().default({}) }).strict(),
  z.object({ operation: z.literal("configure"), rules: z.unknown() }).strict(),
]);
export async function executeServiceRequestOperation(context: {
  actor: ServiceRequestActor; conversationId?: string; representativeVersionId?: string;
  generateOptions?: (question: string) => Promise<Array<{ id: string; label: string }>>;
}, value: unknown) {
  const parsed = operationSchema.safeParse(value);
  if (!parsed.success) throw new ServiceRequestError("invalid_operation", 400);
  const op = parsed.data;
  if (op.operation === "configure") return setServiceBoundaryDraft(context.actor, op.rules);
  if (op.operation === "resolve") return resolveServiceRequest(context.actor, op.id, op.action, op.text);
  if (op.operation === "create") {
    if (!context.conversationId || !context.representativeVersionId) throw new ServiceRequestError("visitor_context_required", 400);
    return createServiceRequestBatch({ actor: context.actor, conversationId: context.conversationId, representativeVersionId: context.representativeVersionId }, op.batch);
  }
  const parent = await getServiceRequest(context.actor, op.id);
  const options = op.mode === "follow_up" ? [...op.options.filter(option => option.id !== "other"), { id: "other", label: "其他" }] : [];
  if (new Set(options.map(option => option.id)).size !== options.length) throw new ServiceRequestError("duplicate_options", 400);
  const originalOptions = parent.options as Array<{ id: string; label: string }>;
  const selected = op.reply.selectedOptionId ? originalOptions.find(option => option.id === op.reply.selectedOptionId) : undefined;
  if (op.mode === "answer" && (op.reply.selectedOptionId && !selected || !selected && !op.reply.text?.trim()
    || selected?.id === "other" && !op.reply.text?.trim())) throw new ServiceRequestError("invalid_answer", 400);
  return createServiceRequestSuccessor({ actor: context.actor, parentId: op.id, mode: op.mode,
    ...op.item, kind: op.item.ruleIds[0]!, options, representativeVersionId: context.representativeVersionId ?? parent.representativeVersionId,
    ...(op.mode === "follow_up" && context.generateOptions ? { generateOptions: context.generateOptions } : {}),
    reply: op.mode === "follow_up" ? { action: "follow_up", text: op.item.content }
      : { action: "answer", ...op.reply, ...(selected ? { selectedOptionLabel: selected.label } : {}) }, idempotencyKey: op.idempotencyKey });
}
export async function queryServiceRequestOperation(actor: ServiceRequestActor, params: URLSearchParams) {
  if (params.get("configuration") === "true") return getServiceBoundaryDraft(actor);
  const id = params.get("id");
  if (id) return params.get("chain") === "true"
    ? getServiceRequestChain(actor, id, Number(params.get("offset") ?? 0), Number(params.get("limit") ?? 25))
    : getServiceRequest(actor, id);
  const box = params.get("box");
  const status = params.get("status");
  const limit = Number(params.get("limit") ?? 25);
  if (actor.role === "visitor" && params.has("objectId")) throw new ServiceRequestError("invalid_object", 400);
  if (box && box !== "received" && box !== "sent" && box !== "all" || status && !["pending", "accepted", "rejected", "disabled"].includes(status)
    || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ServiceRequestError("invalid_query", 400);
  return listServiceRequests(actor, {
    ...(box ? { box: box as "received" | "sent" | "all" } : {}), ...(status ? { status } : {}), limit,
    ...(actor.role === "owner" && params.get("objectId") ? { contactId: params.get("objectId")! } : {}),
    ...(params.get("kind") ? { kind: params.get("kind")! } : {}),
    ...(params.get("from") ? { from: new Date(params.get("from")!) } : {}),
    ...(params.get("to") ? { to: new Date(params.get("to")!) } : {}),
    ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}), ascending: params.get("order") === "asc",
  });
}

// Internal identity keys, hashes and idempotency tokens never leave HTTP/tool boundaries.
export function serviceRequestPublicResult(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serviceRequestPublicResult);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !["audienceIdentityId", "contactId", "payloadHash", "idempotencyKey"].includes(key)).map(([key, item]) => [key, serviceRequestPublicResult(item)]));
  return value;
}
