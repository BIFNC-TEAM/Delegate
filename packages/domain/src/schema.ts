import { z } from "zod";

export const channelSchema = z.enum([
  "private_chat",
  "group_mention",
  "group_reply",
  "channel_entry",
]);

export const audienceRoleSchema = z.enum([
  "lead",
  "partner",
  "candidate",
  "media",
  "community",
  "other",
]);

export const knowledgeDocumentKindSchema = z.enum([
  "bio",
  "faq",
  "policy",
  "pricing",
  "case_study",
  "deck",
  "calendar",
  "download",
]);

export const representativeSkillSchema = z.enum([
  "faq_reply",
  "lead_qualify",
  "intake_collect",
  "quote_request_collect",
  "material_delivery",
  "scheduling_request",
  "human_handoff",
  "paid_unlock",
]);

export const skillPackSourceSchema = z.enum(["builtin", "owner_upload", "clawhub"]);

export const groupActivationSchema = z.enum(["mention_only", "reply_or_mention", "always"]);

export const planTierSchema = z.enum(["free", "pass", "deep_help", "sponsor"]);

export const gateModeSchema = z.enum(["allow", "ask_first", "deny"]);

export const actionKeySchema = z.enum([
  "answer_faq",
  "collect_lead",
  "collect_quote_request",
  "collect_scheduling_request",
  "deliver_material",
  "request_handoff",
  "charge_stars",
  "issue_refund",
  "offer_discount",
  "send_sensitive_material",
  "modify_owner_calendar",
  "run_local_command",
  "access_private_memory",
  "access_private_files",
  "send_outbound_campaign",
]);

export const inquiryIntentSchema = z.enum([
  "faq",
  "collaboration",
  "pricing",
  "materials",
  "scheduling",
  "handoff",
  "refund",
  "discount",
  "candidate",
  "media",
  "support",
  "restricted",
  "unknown",
]);

export const knowledgeDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: knowledgeDocumentKindSchema,
  summary: z.string(),
  url: z.string().url().optional(),
});

export const conversationContractSchema = z.object({
  // Zero is the explicit no-trial boundary used by CREDITS_ONLY and is also a
  // valid trial configuration before an owner switches access modes.
  freeReplyLimit: z.number().int().nonnegative(),
  freeScope: z.array(inquiryIntentSchema),
  paywalledIntents: z.array(inquiryIntentSchema),
  handoffWindowHours: z.number().int().positive(),
});

export const knowledgePackSchema = z.object({
  identitySummary: z.string(),
  faq: z.array(knowledgeDocumentSchema),
  materials: z.array(knowledgeDocumentSchema),
  policies: z.array(knowledgeDocumentSchema),
});

export const actionGateSchema = z.record(actionKeySchema, gateModeSchema);

export const skillPackSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  source: skillPackSourceSchema,
  summary: z.string(),
  version: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  ownerHandle: z.string().optional(),
  verificationTier: z.string().optional(),
  capabilityTags: z.array(z.string()),
  executesCode: z.boolean(),
  enabled: z.boolean(),
  installStatus: z.enum(["available", "installed", "update_available"]),
});

export const representativeSchema = z.object({
  id: z.string(),
  slug: z.string(),
  ownerName: z.string(),
  name: z.string(),
  avatarUrl: z.string().url().optional(),
  tagline: z.string(),
  tone: z.string(),
  languages: z.array(z.string()),
  groupActivation: groupActivationSchema,
  skills: z.array(representativeSkillSchema),
  skillPacks: z.array(skillPackSchema),
  knowledgePack: knowledgePackSchema,
  contract: conversationContractSchema,
  handoffPrompt: z.string(),
  actionGate: actionGateSchema,
});

export type Channel = z.infer<typeof channelSchema>;
export type AudienceRole = z.infer<typeof audienceRoleSchema>;
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type RepresentativeSkill = z.infer<typeof representativeSkillSchema>;
export type SkillPackSource = z.infer<typeof skillPackSourceSchema>;
export type GroupActivation = z.infer<typeof groupActivationSchema>;
export type PlanTier = z.infer<typeof planTierSchema>;
export type GateMode = z.infer<typeof gateModeSchema>;
export type ActionKey = z.infer<typeof actionKeySchema>;
export type InquiryIntent = z.infer<typeof inquiryIntentSchema>;
export type ConversationContract = z.infer<typeof conversationContractSchema>;
export type KnowledgePack = z.infer<typeof knowledgePackSchema>;
export type SkillPack = z.infer<typeof skillPackSchema>;
export type Representative = z.infer<typeof representativeSchema>;
