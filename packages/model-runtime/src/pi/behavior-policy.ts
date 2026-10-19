import { z } from "zod";
import type { AgentBehavior } from "@delegate/domain";
import type { PiToolObservation } from "./types";

export const behaviorAssessmentSchema = z.object({
  topic: z.enum(["owner_fact", "specialty", "general", "task", "conversation"]),
  withinAnswerScope: z.boolean(),
  knowledgeBasis: z.enum(["authorized", "general_supplement", "other"]),
  commitment: z.enum(["none", "existing_terms", "new"]),
}).strict();
type BehaviorAssessment = z.infer<typeof behaviorAssessmentSchema>;

/** Semantic categories are reviewed by the model; access rights still come from the server. */
export function checkBehaviorEvidence(input: {
  policy?: AgentBehavior | undefined;
  assessment?: BehaviorAssessment | undefined;
  responseKind: string;
  supporting: PiToolObservation[];
  observations: PiToolObservation[];
}) {
  if (!input.policy) return { failures: [] as string[], generalSupplement: false };
  const { policy, assessment: check } = input;
  if (!check) return { failures: ["The published answer policy was not checked."], generalSupplement: false };
  const failures: string[] = [];
  const knowledge = input.supporting.some(o => o.toolName === "retrieve_authorized_knowledge" && o.sources.some(source => source.channel === "knowledge"));
  const noMatch = input.observations.some(o => o.toolName === "retrieve_authorized_knowledge" && o.status === "not_found"
    && (!o.observation || ["empty", "available"].includes(o.observation.state)));
  const generalSupplement = input.responseKind === "result" && check.topic === "specialty" && policy.knowledgePolicy === "domain_first"
    && check.knowledgeBasis === "general_supplement" && noMatch;
  if (input.responseKind === "result") {
    if (!check.withinAnswerScope || (policy.answerScope === "owner_and_domain" && check.topic === "general")) failures.push("The answer is outside the published answering scope; explain the boundary without changing the topic.");
    if (check.topic === "owner_fact" && !knowledge) failures.push("Owner-specific claims require successful authorized knowledge evidence.");
    if (check.topic === "specialty" && policy.knowledgePolicy !== "owner_facts" && !knowledge && !generalSupplement) failures.push("This specialty answer needs authorized materials or the explicitly permitted, labeled supplement after an accessible no-match.");
  }
  if (check.commitment === "new" || (check.commitment === "existing_terms" && (policy.commitmentPolicy !== "authorized_terms" || !knowledge))) {
    failures.push("The candidate undertakes an owner commitment outside the configured boundary or without authorized terms.");
  }
  return { failures, generalSupplement };
}
