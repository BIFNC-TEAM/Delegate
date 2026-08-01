import { compactMarkdownLines, sanitizePublicSafeText } from "./filter";
import {
  buildRepresentativeAgentMemoryUri,
  buildRepresentativeFaqUri,
  buildRepresentativeIdentityUri,
  buildRepresentativeMaterialsUri,
  buildRepresentativePoliciesUri,
  buildRepresentativePricingUri,
  buildRepresentativeContactMemoryUri,
  buildRepresentativeVersionResourceRootUri,
} from "./uris";
import type { OpenVikingDocumentSpec } from "./types";

type KnowledgeDocument = {
  title: string;
  summary: string;
  url?: string;
};

type PricingPlan = {
  tier: string;
  name: string;
  stars: number;
  summary: string;
  includedReplies: number;
  includesPriorityHandoff: boolean;
};

type RepresentativeKnowledgeInput = {
  slug: string;
  representativeVersionId?: string;
  ownerName?: string;
  name: string;
  tagline: string;
  tone: string;
  languages: string[];
  groupActivation: string;
  publicMode: boolean;
  humanInLoop: boolean;
  freeReplyLimit: number;
  freeScope: string[];
  paywalledIntents: string[];
  handoffWindowHours: number;
  skills: string[];
  knowledgePack: {
    identitySummary: string;
    faq: KnowledgeDocument[];
    materials: KnowledgeDocument[];
    policies: KnowledgeDocument[];
  };
  pricing: PricingPlan[];
  handoffPrompt: string;
};

export function buildRepresentativeKnowledgeDocuments(
  input: RepresentativeKnowledgeInput,
): OpenVikingDocumentSpec[] {
  const resourceRootUri = input.representativeVersionId
    ? buildRepresentativeVersionResourceRootUri(input.slug, input.representativeVersionId)
    : undefined;

  return [
    {
      uri: buildRepresentativeIdentityUri(input.slug, resourceRootUri),
      filename: "identity.md",
      reason: "Representative public identity and runtime boundary",
      contextType: "resource",
      scope: "representative",
      category: "identity",
      content: compactMarkdownLines([
        `# ${input.name}`,
        ``,
        ...(input.ownerName ? [`Owner: ${input.ownerName}`] : []),
        `Tagline: ${input.tagline}`,
        `Tone: ${input.tone}`,
        `Languages: ${input.languages.join(", ")}`,
        `Public mode: ${input.publicMode ? "true" : "false"}`,
        `Human in loop: ${input.humanInLoop ? "true" : "false"}`,
        `Group activation: ${input.groupActivation}`,
        ``,
        `## Identity summary`,
        input.knowledgePack.identitySummary,
        ``,
        `## Skills`,
        input.skills.map((skill) => `- ${skill}`).join("\n"),
        ``,
        `## Handoff prompt`,
        input.handoffPrompt,
      ]),
    },
    {
      uri: buildRepresentativeFaqUri(input.slug, resourceRootUri),
      filename: "faq.md",
      reason: "Representative FAQ answers",
      contextType: "resource",
      scope: "representative",
      category: "faq",
      content: renderDocumentList("FAQ", input.knowledgePack.faq),
    },
    {
      uri: buildRepresentativeMaterialsUri(input.slug, resourceRootUri),
      filename: "materials.md",
      reason: "Representative public materials and links",
      contextType: "resource",
      scope: "representative",
      category: "materials",
      content: renderDocumentList("Materials", input.knowledgePack.materials),
    },
    {
      uri: buildRepresentativePoliciesUri(input.slug, resourceRootUri),
      filename: "policies.md",
      reason: "Representative public policies and capability boundaries",
      contextType: "resource",
      scope: "representative",
      category: "policies",
      content: compactMarkdownLines([
        `# Policies`,
        ``,
        renderDocumentList("Policies", input.knowledgePack.policies),
        ``,
        `## Conversation contract`,
        `- Free reply limit: ${input.freeReplyLimit}`,
        `- Free scope: ${input.freeScope.join(", ")}`,
        `- Paywalled intents: ${input.paywalledIntents.join(", ")}`,
        `- Handoff window: ${input.handoffWindowHours} hours`,
      ]),
    },
    {
      uri: buildRepresentativePricingUri(input.slug, resourceRootUri),
      filename: "pricing.md",
      reason: "Representative public pricing and paid continuation plans",
      contextType: "resource",
      scope: "representative",
      category: "pricing",
      content: compactMarkdownLines([
        `# Pricing`,
        ``,
        ...input.pricing.flatMap((plan) => [
          `## ${plan.name}`,
          `- Tier: ${plan.tier}`,
          `- Stars: ${plan.stars}`,
          `- Replies: ${plan.includedReplies}`,
          `- Priority handoff: ${plan.includesPriorityHandoff ? "yes" : "no"}`,
          plan.summary,
          ``,
        ]),
      ]),
    },
  ];
}

export function buildCollectorMemoryDocument(params: {
  representativeSlug: string;
  contactId: string;
  collectorKind: "quote" | "scheduling";
  key: string;
  title: string;
  summary: string;
  lines: string[];
}): OpenVikingDocumentSpec | null {
  const safeSummary = sanitizePublicSafeText(params.summary, 1000);
  if (!safeSummary) {
    return null;
  }

  const safeLines = params.lines.flatMap((line) => {
    const sanitized = sanitizePublicSafeText(line, 400);
    return sanitized ? [sanitized] : [];
  });

  return {
    uri: buildRepresentativeContactMemoryUri({
      representativeSlug: params.representativeSlug,
      contactId: params.contactId,
      category: "events",
      key: params.key,
    }),
    filename: `${params.key}.md`,
    reason: "Structured collector completion for future recall inside this representative only",
    contextType: "memory",
    scope: "contact",
    category: params.collectorKind,
    content: compactMarkdownLines([
      `# ${params.title}`,
      ``,
      safeSummary,
      ``,
      ...safeLines,
    ]),
  };
}

export function buildPaymentMemoryDocument(params: {
  representativeSlug: string;
  contactId: string;
  key: string;
  planName: string;
  starsAmount: number;
}): OpenVikingDocumentSpec {
  return {
    uri: buildRepresentativeContactMemoryUri({
      representativeSlug: params.representativeSlug,
      contactId: params.contactId,
      category: "events",
      key: params.key,
    }),
    filename: `${params.key}.md`,
    reason: "Public-safe payment unlock state for future routing and prioritization",
    contextType: "memory",
    scope: "contact",
    category: "payment",
    content: compactMarkdownLines([
      `# Paid unlock`,
      ``,
      `The contact unlocked ${params.planName} for ${params.starsAmount} Stars.`,
    ]),
  };
}

export function buildHandoffResolutionPatternDocument(params: {
  representativeSlug: string;
  key: string;
  title: string;
  summary: string;
  recommendedAction: string;
  status: string;
}): OpenVikingDocumentSpec | null {
  const safeSummary = sanitizePublicSafeText(params.summary, 1000);
  if (!safeSummary) {
    return null;
  }

  const safeRecommendedAction = sanitizePublicSafeText(params.recommendedAction, 400);

  return {
    uri: buildRepresentativeAgentMemoryUri({
      representativeSlug: params.representativeSlug,
      category: "cases",
      key: params.key,
    }),
    filename: `${params.key}.md`,
    reason: "Representative-level learned case from resolved handoff workflow",
    contextType: "memory",
    scope: "agent",
    category: "handoff_case",
    content: compactMarkdownLines([
      `# ${params.title}`,
      ``,
      `Status: ${params.status}`,
      safeRecommendedAction
        ? `Recommended action: ${safeRecommendedAction}`
        : "Recommended action omitted because it did not pass the public-safe filter.",
      ``,
      safeSummary,
    ]),
  };
}

function renderDocumentList(title: string, documents: KnowledgeDocument[]): string {
  return compactMarkdownLines([
    `# ${title}`,
    ``,
    ...documents.flatMap((document) => [
      `## ${document.title}`,
      sanitizePublicSafeText(document.summary, 2000) ?? "Summary omitted because it did not pass the public-safe filter.",
      ...(document.url ? [`Source: ${document.url}`] : []),
      ``,
    ]),
  ]);
}
