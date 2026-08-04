function sanitizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

export type GovernedMemoryChannel = "web" | "matrix" | "telegram";

const GOVERNED_MEMORY_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Builds the P0 recall boundary for one contact on one source channel.
 *
 * `namespaceKey` is generated and persisted by the server. Callers must not
 * derive it from an Owner-editable representative slug or a remote Agent ID.
 */
export function buildGovernedContactChannelMemoryRootUri(params: {
  namespaceKey: string;
  contactId: string;
  channel: GovernedMemoryChannel;
}): string {
  return `viking://user/memories/delegate/${requireGovernedMemorySegment(
    params.namespaceKey,
    "namespaceKey",
  )}/contacts/${requireGovernedMemorySegment(
    params.contactId,
    "contactId",
  )}/channels/${normalizeGovernedMemoryChannel(params.channel)}/`;
}

/** Builds the exact projection URI for one immutable contact-memory version. */
export function buildGovernedContactChannelMemoryVersionUri(params: {
  namespaceKey: string;
  contactId: string;
  channel: GovernedMemoryChannel;
  memoryId: string;
  memoryVersionId: string;
}): string {
  return `${buildGovernedContactChannelMemoryRootUri(params)}memories/${requireGovernedMemorySegment(
    params.memoryId,
    "memoryId",
  )}/versions/${requireGovernedMemorySegment(
    params.memoryVersionId,
    "memoryVersionId",
  )}.md`;
}

/** Builds the representative-wide, deidentified experience recall boundary. */
export function buildGovernedRepresentativeExperienceRootUri(namespaceKey: string): string {
  return `viking://agent/memories/delegate/${requireGovernedMemorySegment(
    namespaceKey,
    "namespaceKey",
  )}/representative-experience/`;
}

/** Builds the exact projection URI for one immutable representative-experience version. */
export function buildGovernedRepresentativeExperienceVersionUri(params: {
  namespaceKey: string;
  memoryId: string;
  memoryVersionId: string;
}): string {
  return `${buildGovernedRepresentativeExperienceRootUri(params.namespaceKey)}memories/${requireGovernedMemorySegment(
    params.memoryId,
    "memoryId",
  )}/versions/${requireGovernedMemorySegment(
    params.memoryVersionId,
    "memoryVersionId",
  )}.md`;
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

export function sanitizeVikingSegment(value: string): string {
  return sanitizeSegment(value);
}

function normalizeRootUri(uri: string): string {
  return `${uri.replace(/\/+$/, "")}/`;
}

function normalizeGovernedMemoryChannel(channel: GovernedMemoryChannel): GovernedMemoryChannel {
  if (channel === "web" || channel === "matrix" || channel === "telegram") {
    return channel;
  }

  throw new Error(`Unsupported governed memory channel: ${String(channel)}`);
}

function requireGovernedMemorySegment(value: string, field: string): string {
  if (typeof value !== "string" || !GOVERNED_MEMORY_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid governed memory ${field}`);
  }

  return value;
}
