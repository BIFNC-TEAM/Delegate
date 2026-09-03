import {
  capabilityAuthorityClassV3Schema,
  capabilityEvidenceClassV3Schema,
  capabilityFreshnessClassV3Schema,
  capabilityOperationV3Schema,
  capabilitySemanticRequirementV3Schema,
  type CapabilitySemanticRequirementV3,
} from "@delegate/runtime";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import {
  createConfiguredPlannerAdapters,
  type StrictPlannerAdapter,
  type StrictPlannerRequest,
} from "./turn-planner";

const sourceRequirementProposalV3Schema = z.object({
  protocolVersion: z.literal(3),
  operations: z.array(capabilityOperationV3Schema).min(1).max(8),
  evidenceClasses: z.array(capabilityEvidenceClassV3Schema).min(1).max(8),
  freshnessClasses: z.array(capabilityFreshnessClassV3Schema).min(1).max(4),
  authorityClasses: z.array(capabilityAuthorityClassV3Schema).min(1).max(4),
  confidence: z.number().min(0).max(1),
  reasonCode: z.string().trim().min(1).max(120)
    .regex(/^[a-z][a-z0-9_]*$/u),
}).strict().superRefine((proposal, context) => {
  const evidence = new Set(proposal.evidenceClasses);
  const freshness = new Set(proposal.freshnessClasses);
  const authority = new Set(proposal.authorityClasses);
  if (
    evidence.has("none")
    && (evidence.size !== 1 || freshness.has("live") || !authority.has("general"))
  ) {
    context.addIssue({
      code: "custom",
      path: ["evidenceClasses"],
      message: "Evidence class none is valid only for non-live general knowledge.",
    });
  }
  if (
    evidence.has("current_external")
    && (!freshness.has("live") || !authority.has("external_authoritative"))
  ) {
    context.addIssue({
      code: "custom",
      path: ["evidenceClasses"],
      message: "Current external evidence requires live external authority.",
    });
  }
  if (
    evidence.has("transactional_authority")
    && (!freshness.has("live") || !authority.has("transactional"))
  ) {
    context.addIssue({
      code: "custom",
      path: ["evidenceClasses"],
      message: "Transactional evidence requires live transactional authority.",
    });
  }
  if (
    evidence.has("authorized_knowledge")
    && !authority.has("owner_authorized")
  ) {
    context.addIssue({
      code: "custom",
      path: ["authorityClasses"],
      message: "Authorized knowledge requires Owner-authorized authority.",
    });
  }
});

export type TurnSourceRequirementInferenceV3 =
  | {
      ok: true;
      requirement: CapabilitySemanticRequirementV3;
      confidence: number;
      reasonCode: string;
      provider: string;
      model: string;
    }
  | {
      ok: false;
      reason: string;
      diagnostics: Array<{
        provider: string;
        model: string;
        stage: "unsupported" | "provider" | "schema";
      }>;
    };

export function buildTurnSourceRequirementPromptV3(input: {
  text: string;
  language?: string;
  now?: string;
}): StrictPlannerRequest {
  const parsed = z.object({
    text: z.string().trim().min(1).max(12_000),
    language: z.string().trim().min(1).max(40).optional(),
    now: z.string().datetime(),
  }).strict().parse({
    text: input.text,
    ...(input.language ? { language: input.language } : {}),
    now: input.now ?? new Date().toISOString(),
  });
  const format = zodTextFormat(
    sourceRequirementProposalV3Schema,
    "delegate_turn_source_requirement_v3",
    {
      description:
        "Composable source, freshness, authority, and operation constraints for one user turn.",
    },
  );
  return {
    instructions: [
      "Infer source requirements for the user-visible facts or actions requested in exactly one turn.",
      "Return only the strict JSON object requested by the response schema.",
      "This is not an intent taxonomy and must not name a capability, provider, product, URL, command, policy decision, or approval outcome.",
      "Use composable dimensions: operations, evidenceClasses, freshnessClasses, and authorityClasses.",
      "Use freshness=live for facts whose truth can materially change by the current time or requested as-of time; use bounded for a stated finite dataset or generated result; use stable only for durable explanations.",
      "Use current_external + external_authoritative for current public-world facts; transactional_authority + transactional for account, order, payment, permission, or other authoritative transaction state.",
      "Use authorized_knowledge + owner_authorized for facts specific to the current representative or Owner.",
      "Use evidence=none only for stable general explanations that do not claim current, Owner-specific, capability-result, or transactional facts.",
      "Use capability_result when the requested truth must be produced by calculation, transformation, file processing, browsing, or another governed operation.",
      "A self-contained calculation over values present in the message uses capability_result + bounded + general; it is not transactional authority.",
      "Never use evidence=none for a request to calculate, count, sort, aggregate, transform, execute, generate an exact result, or return a computed list; those requests require capability_result even when a language model might know or mentally derive the answer.",
      "A policy, price, service, schedule, identity, or other published fact belonging to the current representative/Owner uses authorized_knowledge + bounded + owner_authorized; its published version is the bounded authority even when the Owner may update a later version. External authority is for public-world sources outside that Owner boundary.",
      "A durable public concept or theorem requested as an explanation uses evidence=none + stable + general unless the user explicitly requires citations or a named source.",
      "For a mixed turn, return the union of required dimensions. Never weaken a stronger live, external, Owner-specific, or transactional requirement because another clause is stable.",
      "If uncertain, preserve the stronger evidence, freshness, and authority requirement; this output may narrow retrieval but can never grant authority.",
    ].join("\n"),
    input: JSON.stringify(parsed),
    responseSchema: {
      name: "delegate_turn_source_requirement_v3",
      description:
        "Composable source, freshness, authority, and operation constraints for one user turn.",
      schema: structuredClone(format.schema) as Record<string, unknown>,
      strict: true,
    },
  };
}

export async function inferTurnSourceRequirementV3(input: {
  text: string;
  language?: string;
  now?: string;
  adapter?: StrictPlannerAdapter;
}): Promise<TurnSourceRequirementInferenceV3> {
  const request = buildTurnSourceRequirementPromptV3(input);
  const resolved = input.adapter
    ? { ok: true as const, adapters: [input.adapter] }
    : createConfiguredPlannerAdapters();
  if (!resolved.ok) {
    return {
      ok: false,
      reason: resolved.result.ok
        ? "Planner adapter resolution failed."
        : resolved.result.reason,
      diagnostics: [],
    };
  }
  const diagnostics: Extract<TurnSourceRequirementInferenceV3, { ok: false }>["diagnostics"] = [];
  for (const adapter of resolved.adapters) {
    if (!adapter.supportsStrictStructuredOutput && adapter.serverValidatedJson !== true) {
      diagnostics.push({
        provider: adapter.provider,
        model: adapter.model,
        stage: "unsupported",
      });
      continue;
    }
    let raw: unknown;
    try {
      raw = await adapter.generateStrictObject(request);
    } catch {
      diagnostics.push({
        provider: adapter.provider,
        model: adapter.model,
        stage: "provider",
      });
      continue;
    }
    const proposal = sourceRequirementProposalV3Schema.safeParse(raw);
    if (!proposal.success) {
      diagnostics.push({
        provider: adapter.provider,
        model: adapter.model,
        stage: "schema",
      });
      continue;
    }
    const requirement = capabilitySemanticRequirementV3Schema.parse({
      operations: [...new Set(proposal.data.operations)],
      evidenceClasses: [...new Set(proposal.data.evidenceClasses)],
      freshnessClasses: [...new Set(proposal.data.freshnessClasses)],
      authorityClasses: [...new Set(proposal.data.authorityClasses)],
    });
    return {
      ok: true,
      requirement,
      confidence: proposal.data.confidence,
      reasonCode: proposal.data.reasonCode,
      provider: adapter.provider,
      model: adapter.model,
    };
  }
  return {
    ok: false,
    reason: "No provider produced a validated source-requirement proposal.",
    diagnostics,
  };
}

/**
 * Model inference may narrow retrieval but may never authorize a general
 * answer or hide governed capabilities. Stable/general/none is therefore an
 * advisory classification only and deliberately becomes a full-catalog
 * retrieval. Strong evidence, live freshness, and non-general authority are
 * safe narrowing constraints because an error can only reduce capability,
 * never broaden authority.
 */
export function constrainTurnSourceRequirementForRetrievalV3(
  input: CapabilitySemanticRequirementV3,
): Partial<CapabilitySemanticRequirementV3> {
  const strongEvidence = input.evidenceClasses.filter((item) => item !== "none");
  const strongFreshness = input.freshnessClasses.filter((item) => item === "live");
  const strongAuthority = input.authorityClasses.filter((item) => item !== "general");
  if (!strongEvidence.length && !strongFreshness.length && !strongAuthority.length) {
    return {};
  }
  return capabilitySemanticRequirementV3Schema.parse({
    // A user-visible read may require supporting search/resolve/transform
    // Actions. Hard-filtering the catalog by the final operation removes
    // valid prerequisite actions such as entity resolution before a live read.
    operations: [],
    evidenceClasses: strongEvidence,
    freshnessClasses: strongFreshness.length
      ? strongFreshness
      : input.freshnessClasses,
    authorityClasses: strongAuthority,
  });
}
