import { z } from "zod";

export const agentContextProofSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1).max(191),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type AgentContextProof = z.infer<typeof agentContextProofSchema>;
export type AgentContextBoundary = "resume" | "model" | "tool" | "tool_result" | "release";
/** Trusted host callbacks, never supplied by model arguments or source content. */
export type AgentContextAuthorization = {
  check(boundary: AgentContextBoundary, expected?: AgentContextProof): Promise<void>;
  snapshot(): AgentContextProof;
  /** Only host-registered result receipts can authorize checkpoint reuse. */
  hasResultSource?(reference: string, toolName: string): boolean;
};
export class AgentContextAuthorizationError extends Error {
  readonly code = "agent_context_authorization_failed";
  constructor() { super("agent_context_authorization_failed"); this.name = "AgentContextAuthorizationError"; }
}
export function isAgentContextAuthorizationError(value: unknown): boolean {
  return value instanceof AgentContextAuthorizationError || Boolean(value && typeof value === "object" && "code" in value && value.code === "agent_context_authorization_failed");
}
export const agentContextBlockedMessage = "当前资料或访问权限无法核验，已停止继续处理。已有操作不会因此自动重做，请先查看其实际回执后再继续。";
