import { z } from "zod";

import type { ConversationDisposition, ConversationPlan } from "./inquiry-routing";
import type { StructuredCollectorState } from "./structured-collector";

export const subagentIdSchema = z.enum([
  "triage-agent",
  "quote-agent",
  "handoff-agent",
  "compute-agent",
  "browser-agent",
]);

export const subagentContextScopeSchema = z.enum([
  "conversation_contract",
  "representative_snapshot",
  "user_message",
  "reply_outline",
  "collector_state",
  "recent_turns",
  "public_knowledge",
  "recalled_context",
]);

export type SubagentId = z.infer<typeof subagentIdSchema>;
export type SubagentContextScope = z.infer<typeof subagentContextScopeSchema>;

export type SubagentBudgetHints = {
  maxInputTokens: number;
  maxRecentTurns: number;
  maxKnowledgeItems: number;
  maxRecallItems: number;
};

export type ResolvedSubagentRoute = {
  id: SubagentId;
  displayName: string;
  purpose: string;
  allowedConversationDispositions: ConversationDisposition[];
  allowedCapabilities: string[];
  contextScopes: SubagentContextScope[];
  budgetHints: SubagentBudgetHints;
};

export type ComputeSubagentRoute = ResolvedSubagentRoute & {
  id: "compute-agent" | "browser-agent";
};

const scopedSubagents: Record<SubagentId, ResolvedSubagentRoute> = {
  "triage-agent": {
    id: "triage-agent",
    displayName: "Triage Agent",
    purpose: "Handle safe public answers, materials, and paywall nudges without leaving the FAQ lane.",
    allowedConversationDispositions: ["answer", "payment_required", "refuse"],
    allowedCapabilities: ["answer_public_information", "deliver_public_material", "payment_required"],
    contextScopes: [
      "conversation_contract",
      "representative_snapshot",
      "user_message",
      "reply_outline",
      "recent_turns",
      "public_knowledge",
      "recalled_context",
    ],
    budgetHints: {
      maxInputTokens: 2200,
      maxRecentTurns: 6,
      maxKnowledgeItems: 6,
      maxRecallItems: 4,
    },
  },
  "quote-agent": {
    id: "quote-agent",
    displayName: "Quote Agent",
    purpose: "Collect structured business context for pricing, collaboration, and scheduling flows.",
    allowedConversationDispositions: ["collect", "payment_required"],
    allowedCapabilities: [
      "collect_contact_and_requirements",
      "create_service_request",
    ],
    contextScopes: [
      "conversation_contract",
      "representative_snapshot",
      "user_message",
      "reply_outline",
      "collector_state",
      "recent_turns",
      "public_knowledge",
      "recalled_context",
    ],
    budgetHints: {
      maxInputTokens: 1800,
      maxRecentTurns: 4,
      maxKnowledgeItems: 4,
      maxRecallItems: 3,
    },
  },
  "handoff-agent": {
    id: "handoff-agent",
    displayName: "Handoff Agent",
    purpose: "Package owner-ready escalation context without promising actions outside the handoff policy.",
    allowedConversationDispositions: ["handoff"],
    allowedCapabilities: ["request_human_handoff"],
    contextScopes: [
      "conversation_contract",
      "representative_snapshot",
      "user_message",
      "reply_outline",
      "recent_turns",
      "recalled_context",
    ],
    budgetHints: {
      maxInputTokens: 1400,
      maxRecentTurns: 4,
      maxKnowledgeItems: 0,
      maxRecallItems: 2,
    },
  },
  "compute-agent": {
    id: "compute-agent",
    displayName: "Compute Agent",
    purpose: "Route governed compute requests into the isolated sandbox for non-browser capabilities.",
    allowedConversationDispositions: ["answer"],
    allowedCapabilities: ["exec", "read", "write", "process", "mcp"],
    contextScopes: [
      "conversation_contract",
      "representative_snapshot",
      "user_message",
      "recent_turns",
      "recalled_context",
    ],
    budgetHints: {
      maxInputTokens: 1200,
      maxRecentTurns: 3,
      maxKnowledgeItems: 0,
      maxRecallItems: 2,
    },
  },
  "browser-agent": {
    id: "browser-agent",
    displayName: "Browser Agent",
    purpose: "Route governed browser work into the retained Playwright session and approval flow.",
    allowedConversationDispositions: ["answer"],
    allowedCapabilities: ["browser"],
    contextScopes: [
      "conversation_contract",
      "representative_snapshot",
      "user_message",
      "recent_turns",
      "recalled_context",
    ],
    budgetHints: {
      maxInputTokens: 1200,
      maxRecentTurns: 3,
      maxKnowledgeItems: 0,
      maxRecallItems: 2,
    },
  },
};

export function listScopedSubagents(): ResolvedSubagentRoute[] {
  return Object.values(scopedSubagents);
}

export function getScopedSubagent(id: SubagentId): ResolvedSubagentRoute {
  return scopedSubagents[id];
}

export function resolveConversationSubagent(plan: ConversationPlan): ResolvedSubagentRoute {
  if (plan.disposition === "collect") {
    return getScopedSubagent("quote-agent");
  }

  if (plan.disposition === "handoff") {
    return getScopedSubagent("handoff-agent");
  }

  return getScopedSubagent("triage-agent");
}

export function resolveCollectorSubagent(
  _collectorState: StructuredCollectorState,
): ResolvedSubagentRoute {
  return getScopedSubagent("quote-agent");
}

export function resolveComputeSubagent(capability: string): ComputeSubagentRoute {
  if (capability === "browser") {
    return getScopedSubagent("browser-agent") as ComputeSubagentRoute;
  }

  return getScopedSubagent("compute-agent") as ComputeSubagentRoute;
}
