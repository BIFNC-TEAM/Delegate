import { z } from "zod";

export const serviceBoundaryPresets = ["appointment", "discount", "scope", "dispute", "human"] as const;
export const serviceBoundaryActionSchema = z.enum(["approve", "handoff", "decline"]);
export const publishedServiceBoundariesSchema = z.object({
  version: z.literal(1),
  boundaries: z.array(z.object({
    id: z.string().min(1).max(100), request: z.string().trim().max(200), action: serviceBoundaryActionSchema,
  }).strict()).max(50),
}).strict().superRefine((value, context) => {
  const ids = value.boundaries.map(rule => rule.id);
  if (new Set(ids).size !== ids.length || serviceBoundaryPresets.some(id => !ids.includes(id))) {
    context.addIssue({ code: "custom", message: "Unique rules including every preset are required." });
  }
  if (value.boundaries.some(rule => !serviceBoundaryPresets.some(id => id === rule.id) && !rule.request)) {
    context.addIssue({ code: "custom", message: "Custom rules require a request description." });
  }
});
export type PublishedServiceBoundaries = z.infer<typeof publishedServiceBoundariesSchema>;
export class ServiceRequestError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}
export function readServiceRequestLimit(environment: NodeJS.ProcessEnv = process.env): number {
  const value = environment.DELEGATE_SERVICE_REQUEST_MAX_ITEMS;
  if (value === undefined) return 5;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 100) throw new ServiceRequestError("invalid_server_limit", 500);
  return Number(value);
}
export function resolveServiceBoundaryAction(config: PublishedServiceBoundaries, ruleIds: string[]) {
  if (!ruleIds.length || new Set(ruleIds).size !== ruleIds.length) throw new ServiceRequestError("invalid_rules", 400);
  const rules = ruleIds.map(id => config.boundaries.find(rule => rule.id === id));
  if (rules.some(rule => !rule)) throw new ServiceRequestError("unknown_rule", 400);
  return rules.some(rule => rule!.action === "decline") ? "decline"
    : rules.some(rule => rule!.action === "handoff") ? "handoff" : "approve";
}
export const serviceRequestItemSchema = z.object({
  itemId: z.string().min(1).max(100),
  content: z.string().min(1).max(8000).refine(value => Boolean(value.trim())),
  summary: z.string().min(1).max(2000).refine(value => Boolean(value.trim())),
  ruleIds: z.array(z.string().min(1).max(100)).min(1).max(50),
}).strict();
export const serviceRequestBatchSchema = z.object({
  messageId: z.string().min(1).max(100),
  overflow: z.boolean(),
  items: z.array(serviceRequestItemSchema).max(101),
}).strict();
export function validateServiceRequestBatch(value: unknown, limit = readServiceRequestLimit()) {
  const parsed = serviceRequestBatchSchema.safeParse(value);
  if (!parsed.success) throw new ServiceRequestError("invalid_batch", 400);
  if (parsed.data.overflow || parsed.data.items.length > limit) throw new ServiceRequestError("too_many_requests", 422);
  if (new Set(parsed.data.items.map(item => item.itemId)).size !== parsed.data.items.length) throw new ServiceRequestError("duplicate_item_id", 400);
  return parsed.data;
}
