import { compactMarkdownLines, sanitizePublicSafeText } from "./filter";
import {
  buildRepresentativeFaqUri,
  buildRepresentativeIdentityUri,
  buildRepresentativeMaterialsUri,
  buildRepresentativePoliciesUri,
  buildRepresentativeVersionResourceRootUri,
} from "./uris";
import type { OpenVikingDocumentSpec } from "./types";

type KnowledgeDocument = {
  title: string;
  summary: string;
  url?: string;
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
  handoffWindowHours: number;
  skills: string[];
  knowledgePack: {
    identitySummary: string;
    faq: KnowledgeDocument[];
    materials: KnowledgeDocument[];
    policies: KnowledgeDocument[];
  };
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
        `- Handoff window: ${input.handoffWindowHours} hours`,
        `- Tools and external side effects require capability-policy evaluation.`,
      ]),
    },
  ];
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
