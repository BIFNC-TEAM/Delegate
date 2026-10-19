import { z } from "zod";

// Initial guardrails, not measured optima. All limits are per task except activeMs.
export const v2BudgetSchema = z.object({
  activeMs: z.number().int().min(20).max(600_000).default(120_000),
  finalReserveMs: z.number().int().min(1).default(15_000),
  toolTimeoutMs: z.number().int().positive().default(25_000),
  modelTurns: z.number().int().min(2).max(32).default(8),
  toolCalls: z.number().int().positive().max(100).default(12),
  attempts: z.number().int().positive().max(200).default(16),
  concurrency: z.number().int().positive().max(16).default(3),
  toolOutputBytes: z.number().int().min(256).max(128_000).default(12_000),
  contextBytes: z.number().int().min(1024).max(512_000).default(64_000),
  totalTokens: z.number().int().min(1024).default(200_000),
  outputTokens: z.number().int().min(128).default(2048),
  finalReserveTokens: z.number().int().min(64).default(512),
  readRetries: z.number().int().min(0).max(2).default(1),
  directTools: z.number().int().min(1).max(64).default(16),
  costUsd: z.number().positive().optional(),
  temperature: z.number().min(0).max(1).default(0),
}).strict().refine(c => c.finalReserveMs < c.activeMs && c.finalReserveTokens <= c.outputTokens,
  "Final reserves must fit the active deadline and output limit.");
export type V2Budget = z.infer<typeof v2BudgetSchema>;

export function resolveV2Budget(env: NodeJS.ProcessEnv = process.env): V2Budget {
  const names = { activeMs: "ACTIVE_MS", finalReserveMs: "FINAL_RESERVE_MS", toolTimeoutMs: "TOOL_TIMEOUT_MS",
    modelTurns: "MODEL_TURNS", toolCalls: "TOOL_CALLS", attempts: "ATTEMPTS", concurrency: "CONCURRENCY",
    toolOutputBytes: "TOOL_OUTPUT_BYTES", contextBytes: "CONTEXT_BYTES", totalTokens: "TOTAL_TOKENS",
    outputTokens: "OUTPUT_TOKENS", finalReserveTokens: "FINAL_RESERVE_TOKENS", readRetries: "READ_RETRIES",
    directTools: "DIRECT_TOOLS", costUsd: "COST_USD", temperature: "TEMPERATURE" };
  return v2BudgetSchema.parse(Object.fromEntries(Object.entries(names).flatMap(([key, suffix]) => {
    const value = env[`DELEGATE_V2_${suffix}`];
    return value === undefined ? [] : [[key, Number(value)]];
  })));
}
