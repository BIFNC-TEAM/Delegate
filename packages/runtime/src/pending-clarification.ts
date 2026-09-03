import { z } from "zod";

import { capabilitySemanticRequirementV3Schema } from "./turn-planning-v3";

const identifier = z.string().trim().min(1).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const jsonObject = z.record(z.string(), z.unknown());

export const pendingClarificationSpecSchema = z.object({
  protocolVersion: z.literal(1),
  source: z.enum(["turn_plan_v3", "legacy_compute"]),
  originInputMessageId: z.string().trim().min(1).max(200),
  originPlanId: z.string().trim().min(1).max(200).optional(),
  representativeVersionId: z.string().trim().min(1).max(200).optional(),
  objective: z.string().trim().min(1).max(4_000),
  capabilityPins: z.array(z.object({
    key: z.string().trim().min(3).max(200),
    version: z.string().trim().min(1).max(120),
    definitionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  }).strict()).max(32),
  missingSlots: z.array(z.object({
    id: identifier,
    argumentPath: z.string().trim().min(1).max(500).regex(/^\//u),
    schema: jsonObject,
    prompt: z.string().trim().min(1).max(500),
  }).strict()).min(1).max(16),
  semanticRequirement: capabilitySemanticRequirementV3Schema.optional(),
  clarificationCount: z.number().int().min(0).max(8),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export type PendingClarificationSpec = z.infer<typeof pendingClarificationSpecSchema>;

const slotValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const continuationDecisionProposalSchema = z.object({
  protocolVersion: z.literal(1),
  decision: z.enum(["continue", "replace", "cancel", "ambiguous"]),
  bindings: z.array(z.object({
    slotId: identifier,
    value: slotValueSchema,
  }).strict()).max(16),
  confidence: z.number().min(0).max(1),
  reasonCode: z.string().trim().min(1).max(120)
    .regex(/^[a-z][a-z0-9_]*$/u),
}).strict();

export type ContinuationDecision = z.infer<typeof continuationDecisionProposalSchema>;
