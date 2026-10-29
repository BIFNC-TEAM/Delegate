import { z } from "zod";

const field = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u).refine(value => !["__proto__", "prototype", "constructor"].includes(value));
const receipt = z.object({ keyField: field, stateField: field,
  succeeded: z.array(z.string().min(1)).min(1).max(8), failedNoEffect: z.array(z.string().min(1)).max(8),
  pending: z.array(z.string().min(1)).max(8), notFound: z.array(z.string().min(1)).max(8),
}).strict().refine(value => {
  const values = [...value.succeeded, ...value.failedNoEffect, ...value.pending, ...value.notFound];
  return new Set(values).size === values.length && value.keyField !== value.stateField;
});
/** Only the server-owned policy registry can supply this contract. MCP
 * annotations, owner form fields and model arguments are not attestations. */
export const mcpRecoveryContractSchema = z.discriminatedUnion("mode", [
  z.object({ version: z.literal(1), id: z.string().min(1).max(160), mode: z.literal("none") }).strict(),
  z.object({ version: z.literal(1), id: z.string().min(1).max(160), mode: z.literal("natural_read") }).strict(),
  z.object({ version: z.literal(1), id: z.string().min(1).max(160), mode: z.literal("keyed"),
    key: z.discriminatedUnion("kind", [z.object({ kind: z.literal("argument"), name: field }).strict(),
      z.object({ kind: z.literal("header"), name: z.enum(["idempotency-key", "x-idempotency-key"]) }).strict()]),
    scope: z.literal("endpoint_tool"), retentionSeconds: z.number().int().min(1).max(7 * 86400),
    receipt,
    query: z.object({ toolName: z.string().min(1).max(160), toolSchemaHash: z.string().regex(/^[a-f0-9]{64}$/u), keyArgument: field, readOnly: z.literal(true) }).strict().optional(),
    cancellation: z.literal("unsupported"), conditionalSubmission: z.literal("unsupported"),
  }).strict(),
]);
export type McpRecoveryContract = z.infer<typeof mcpRecoveryContractSchema>;
export type McpProviderState = "succeeded" | "failed_no_effect" | "pending" | "not_found" | "unknown";
export type McpProviderOperation = {
  contract: McpRecoveryContract;
  key: string;
  argumentsHash: string;
  expiresAt: string | null;
};
export const mcpOutcomeQuerySchema = z.object({ audienceIdentityId: z.string().min(1).max(191) }).strict();
