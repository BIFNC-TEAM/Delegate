import { z } from "zod";

export const openVikingContextTypeSchema = z.enum(["resource", "memory", "skill"]);
export const openVikingLayerSchema = z.enum(["L0", "L1", "L2"]);
export const openVikingCaptureModeSchema = z.enum(["semantic", "keyword"]);
export const openVikingModeSchema = z.enum(["local", "remote"]);
export const openVikingSyncStatusSchema = z.enum(["idle", "running", "succeeded", "failed", "disabled"]);

export const openVikingMatchedContextSchema = z.object({
  uri: z.string(),
  context_type: openVikingContextTypeSchema,
  is_leaf: z.boolean().optional(),
  abstract: z.string().optional(),
  category: z.string().optional(),
  score: z.number().optional(),
  match_reason: z.string().optional(),
});

export const openVikingFindResultSchema = z.object({
  memories: z.array(openVikingMatchedContextSchema).default([]),
  resources: z.array(openVikingMatchedContextSchema).default([]),
  skills: z.array(openVikingMatchedContextSchema).default([]),
  total: z.number().optional(),
});

export const openVikingHealthSchema = z.object({
  status: z.string(),
  healthy: z.boolean().optional(),
  version: z.string().optional(),
});

export const openVikingStatusSchema = z.object({
  initialized: z.boolean().optional(),
  user: z.unknown().optional(),
});

export const openVikingWaitResultSchema = z.object({
  pending: z.number().optional(),
  in_progress: z.number().optional(),
  processed: z.number().optional(),
  errors: z.number().optional(),
});

export const openVikingLsEntrySchema = z.object({
  name: z.string().optional(),
  uri: z.string().optional(),
  type: z.string().optional(),
  abstract: z.string().optional(),
});

export type OpenVikingContextType = z.infer<typeof openVikingContextTypeSchema>;
export type OpenVikingLayer = z.infer<typeof openVikingLayerSchema>;
export type OpenVikingCaptureMode = z.infer<typeof openVikingCaptureModeSchema>;
export type OpenVikingMode = z.infer<typeof openVikingModeSchema>;
export type OpenVikingSyncStatus = z.infer<typeof openVikingSyncStatusSchema>;
export type OpenVikingMatchedContext = z.infer<typeof openVikingMatchedContextSchema>;
export type OpenVikingFindResult = z.infer<typeof openVikingFindResultSchema>;
export type OpenVikingHealth = z.infer<typeof openVikingHealthSchema>;
export type OpenVikingStatus = z.infer<typeof openVikingStatusSchema>;
export type OpenVikingWaitResult = z.infer<typeof openVikingWaitResultSchema>;
export type OpenVikingLsEntry = z.infer<typeof openVikingLsEntrySchema>;

export type OpenVikingDocumentSpec = {
  uri: string;
  filename: string;
  content: string;
  reason: string;
  instruction?: string;
  contextType: "resource" | "memory";
  scope: "representative" | "contact" | "agent";
  category: string;
};

export type OpenVikingRecallItem = {
  uri: string;
  contextType: OpenVikingContextType;
  layer: OpenVikingLayer;
  score: number;
  abstract: string;
  overview?: string;
  content?: string;
};

export type OpenVikingClientScope = {
  accountId?: string;
  userId?: string;
  agentId?: string;
};

export type OpenVikingRecallRequest = {
  query: string;
  targetUri: string;
  limit: number;
  scoreThreshold?: number;
  sessionId?: string;
  useSessionSearch?: boolean;
};

export type OpenVikingClientConfig = OpenVikingClientScope & {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};
