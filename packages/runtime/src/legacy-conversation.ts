/** Persisted plan/trace shapes only. There is no executable legacy planner. */
import type {
  AudienceRole,
  InquiryIntent,
  PlanTier
} from "@delegate/domain";


export type ConversationUsage = {
  freeRepliesUsed: number;
  passUnlocked: boolean;
  deepHelpUnlocked: boolean;
};


export type ConversationGoal =
  | "get_information"
  | "get_material"
  | "provide_information"
  | "create_request"
  | "perform_action"
  | "request_human"
  | "unsafe_request"
  | "unknown";


export type ConversationDisposition =
  | "answer"
  | "collect"
  | "payment_required"
  | "handoff"
  | "refuse";


export type ConversationIntentResult = {
  primaryGoal: ConversationGoal;
  primaryIntent: InquiryIntent;
  businessLabels: string[];
  requestedOutcomes: string[];
  entities: Record<string, string>;
  missingFields: string[];
  confidence: number;
  safetySignals: string[];
};


export type ConversationBillingDecision = {
  decision: "no_charge" | "allow_free" | "allow_entitlement" | "payment_required";
  billable: boolean;
  reason: string;
};


export type ConversationAuthorizationDecision =
  | { decision: "allow"; reason: string }
  | { decision: "ask"; reason: string }
  | { decision: "deny"; reason: string };


export type ConversationActionExecutionResult = {
  actionId: string;
  status: "completed" | "waiting_input" | "waiting_approval" | "deferred" | "denied" | "failed";
  summary: string;
  output?: Record<string, unknown>;
};


export type ConversationTurnTrace = {
  version: 1;
  plan: {
    goal: ConversationGoal;
    intent: InquiryIntent;
    businessLabels: string[];
    requestedOutcomes: string[];
    disposition: ConversationDisposition;
    replyGoal: string;
    reasons: string[];
  };
  billing: ConversationBillingDecision;
  actions: Array<{
    id: string;
    kind: ConversationActionKind;
    authorization: ConversationAuthorizationDecision;
    execution: ConversationActionExecutionResult;
  }>;
};


export type ConversationActionKind =
  | "answer_public_information"
  | "collect_request_description"
  | "deliver_public_material"
  | "create_service_request"
  | "execute_tool"
  | "cancel_pending_action"
  | "request_human_handoff"
  | "refuse_unsafe_request";


export type PlannedConversationAction = {
  id: string;
  kind: ConversationActionKind;
  status: "planned";
  sideEffect: "none" | "internal_record" | "human_queue";
  target?: string;
  /** Optional only while replaying plans persisted before protocol version 1. */
  input?: Record<string, unknown>;
  /** Optional only while replaying plans persisted before protocol version 1. */
  requiredCapabilities?: string[];
  /** Optional only while replaying plans persisted before protocol version 1. */
  externalSideEffect?: boolean;
  estimatedTokens?: number;
};


export type ConversationPlan = {
  goal: ConversationGoal;
  intent: InquiryIntent;
  audienceRole: AudienceRole;
  disposition: ConversationDisposition;
  /** Optional only while replaying plans persisted before protocol version 1. */
  intentResult?: ConversationIntentResult;
  /** Optional only while replaying plans persisted before protocol version 1. */
  billingDecision?: ConversationBillingDecision;
  /** Optional only while replaying plans persisted before protocol version 1. */
  replyGoal?: string;
  actions: PlannedConversationAction[];
  suggestedPlan?: PlanTier;
  reasons: string[];
  responseOutline: string[];
};


/** Protocol-v1 plan emitted by the current planner. */
export type CurrentPlannedConversationAction = PlannedConversationAction & {
  input: Record<string, unknown>;
  requiredCapabilities: string[];
  externalSideEffect: boolean;
};


export type CurrentConversationPlan = ConversationPlan & {
  intentResult: ConversationIntentResult;
  billingDecision: ConversationBillingDecision;
  replyGoal: string;
  actions: CurrentPlannedConversationAction[];
};