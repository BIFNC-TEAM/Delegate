function sanitizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

export function buildRepresentativeResourceRootUri(representativeSlug: string): string {
  return `viking://resources/delegate/reps/${sanitizeSegment(representativeSlug)}/`;
}

export function buildRepresentativeVersionResourceRootUri(
  representativeSlug: string,
  representativeVersionId: string,
): string {
  return `${buildRepresentativeResourceRootUri(representativeSlug)}versions/${sanitizeSegment(
    representativeVersionId,
  )}/`;
}

export function buildRepresentativeKnowledgeRootUri(representativeSlug: string): string {
  return `${buildRepresentativeResourceRootUri(representativeSlug)}knowledge/`;
}

export function buildRepresentativeIdentityUri(
  representativeSlug: string,
  resourceRootUri = buildRepresentativeResourceRootUri(representativeSlug),
): string {
  return `${normalizeRootUri(resourceRootUri)}identity/profile.md`;
}

export function buildRepresentativeFaqUri(
  representativeSlug: string,
  resourceRootUri = buildRepresentativeResourceRootUri(representativeSlug),
): string {
  return `${normalizeRootUri(resourceRootUri)}faq/index.md`;
}

export function buildRepresentativeMaterialsUri(
  representativeSlug: string,
  resourceRootUri = buildRepresentativeResourceRootUri(representativeSlug),
): string {
  return `${normalizeRootUri(resourceRootUri)}materials/index.md`;
}

export function buildRepresentativePoliciesUri(
  representativeSlug: string,
  resourceRootUri = buildRepresentativeResourceRootUri(representativeSlug),
): string {
  return `${normalizeRootUri(resourceRootUri)}policies/index.md`;
}

export function buildRepresentativePricingUri(
  representativeSlug: string,
  resourceRootUri = buildRepresentativeResourceRootUri(representativeSlug),
): string {
  return `${normalizeRootUri(resourceRootUri)}pricing/index.md`;
}

export function buildRepresentativeContactMemoryRootUri(
  representativeSlug: string,
  contactId: string,
): string {
  return `viking://user/memories/delegate/${sanitizeSegment(representativeSlug)}/${sanitizeSegment(contactId)}/`;
}

export function buildRepresentativeContactMemoryUri(params: {
  representativeSlug: string;
  contactId: string;
  category: "profile" | "preferences" | "entities" | "events";
  key: string;
}): string {
  return `${buildRepresentativeContactMemoryRootUri(
    params.representativeSlug,
    params.contactId,
  )}${sanitizeSegment(params.category)}/${sanitizeSegment(params.key)}.md`;
}

export function buildRepresentativeAgentMemoryRootUri(representativeSlug: string): string {
  return `viking://agent/memories/delegate/${sanitizeSegment(representativeSlug)}/`;
}

export function buildRepresentativeAgentMemoryUri(params: {
  representativeSlug: string;
  category: "cases" | "patterns";
  key: string;
}): string {
  return `${buildRepresentativeAgentMemoryRootUri(params.representativeSlug)}${sanitizeSegment(
    params.category,
  )}/${sanitizeSegment(params.key)}.md`;
}

export function buildSessionScopedSearchRoot(params: {
  representativeSlug: string;
  representativeVersionId: string;
  contactId: string;
}): string[] {
  return [
    buildRepresentativeVersionResourceRootUri(
      params.representativeSlug,
      params.representativeVersionId,
    ),
    buildRepresentativeKnowledgeRootUri(params.representativeSlug),
    buildRepresentativeContactMemoryRootUri(params.representativeSlug, params.contactId),
  ];
}

export function buildSyncStagingUri(representativeSlug: string, filename: string): string {
  return `${buildRepresentativeResourceRootUri(representativeSlug)}sync/${sanitizeSegment(filename)}.md`;
}

export function sanitizeVikingSegment(value: string): string {
  return sanitizeSegment(value);
}

function normalizeRootUri(uri: string): string {
  return `${uri.replace(/\/+$/, "")}/`;
}
