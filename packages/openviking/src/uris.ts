function sanitizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

export type GovernedMemoryChannel = "web" | "matrix" | "telegram";

const GOVERNED_MEMORY_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const GOVERNED_MEMORY_MANAGED_USER_PREFIX = "delegate-memory-";
const GOVERNED_MEMORY_URI_ERROR =
  "Governed memory URI must be an exact canonical managed-user root or immutable version leaf.";

export type GovernedMemoryRoot =
  | {
      kind: "contact";
      namespaceKey: string;
      userId: string;
      rootUri: string;
      contactId: string;
      channel: GovernedMemoryChannel;
    }
  | {
      kind: "representative_experience";
      namespaceKey: string;
      userId: string;
      rootUri: string;
    };

export type GovernedMemoryVersion = GovernedMemoryRoot & {
  uri: string;
  memoryId: string;
  memoryVersionId: string;
};

/**
 * The OpenViking identity is derived from the server-generated, immutable
 * namespace key. It is never accepted from an Owner-editable Agent ID.
 */
export function buildGovernedMemoryManagedUserId(namespaceKey: string): string {
  return `${GOVERNED_MEMORY_MANAGED_USER_PREFIX}${requireGovernedMemorySegment(
    namespaceKey,
    "namespaceKey",
  )}`;
}

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
  const namespaceKey = requireGovernedMemorySegment(params.namespaceKey, "namespaceKey");
  return `viking://user/${buildGovernedMemoryManagedUserId(
    namespaceKey,
  )}/memories/delegate/${namespaceKey}/contacts/${requireGovernedMemorySegment(
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
  const canonicalNamespaceKey = requireGovernedMemorySegment(namespaceKey, "namespaceKey");
  return `viking://user/${buildGovernedMemoryManagedUserId(
    canonicalNamespaceKey,
  )}/memories/delegate/${canonicalNamespaceKey}/representative-experience/`;
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

/**
 * Validates an exact governed-memory directory. Shorthand user URIs, Agent
 * URIs, encoded or normalized paths, and descendants of a valid root are all
 * rejected.
 */
export function assertExactGovernedMemoryRootUri(params: {
  namespaceKey: string;
  uri: string;
}): GovernedMemoryRoot {
  const namespaceKey = requireGovernedMemorySegment(params.namespaceKey, "namespaceKey");
  const userId = buildGovernedMemoryManagedUserId(namespaceKey);
  const prefix = governedMemoryNamespacePrefix(namespaceKey);
  requireCanonicalGovernedMemoryUri(params.uri, prefix);

  const suffix = params.uri.slice(prefix.length);
  const segments = suffix.split("/");
  if (
    segments.length === 5
    && segments[0] === "contacts"
    && segments[2] === "channels"
    && segments[4] === ""
  ) {
    const contactId = requireGovernedMemorySegmentForUri(segments[1]);
    const channel = requireGovernedMemoryChannelForUri(segments[3]);
    const rootUri = buildGovernedContactChannelMemoryRootUri({
      namespaceKey,
      contactId,
      channel,
    });
    if (params.uri !== rootUri) throw new Error(GOVERNED_MEMORY_URI_ERROR);
    return {
      kind: "contact",
      namespaceKey,
      userId,
      rootUri,
      contactId,
      channel,
    };
  }

  if (
    segments.length === 2
    && segments[0] === "representative-experience"
    && segments[1] === ""
  ) {
    const rootUri = buildGovernedRepresentativeExperienceRootUri(namespaceKey);
    if (params.uri !== rootUri) throw new Error(GOVERNED_MEMORY_URI_ERROR);
    return {
      kind: "representative_experience",
      namespaceKey,
      userId,
      rootUri,
    };
  }

  throw new Error(GOVERNED_MEMORY_URI_ERROR);
}

/**
 * Validates one immutable governed-memory version leaf and returns its locked
 * root. Only the terminal `.md` suffix is permitted to contain a dot.
 */
export function assertExactGovernedMemoryVersionUri(params: {
  namespaceKey: string;
  uri: string;
}): GovernedMemoryVersion {
  const namespaceKey = requireGovernedMemorySegment(params.namespaceKey, "namespaceKey");
  const userId = buildGovernedMemoryManagedUserId(namespaceKey);
  const prefix = governedMemoryNamespacePrefix(namespaceKey);
  requireCanonicalGovernedMemoryUri(params.uri, prefix);

  const segments = params.uri.slice(prefix.length).split("/");
  if (
    segments.length === 8
    && segments[0] === "contacts"
    && segments[2] === "channels"
    && segments[4] === "memories"
    && segments[6] === "versions"
  ) {
    const contactId = requireGovernedMemorySegmentForUri(segments[1]);
    const channel = requireGovernedMemoryChannelForUri(segments[3]);
    const memoryId = requireGovernedMemorySegmentForUri(segments[5]);
    const memoryVersionId = requireGovernedMemoryVersionFilename(segments[7]);
    const uri = buildGovernedContactChannelMemoryVersionUri({
      namespaceKey,
      contactId,
      channel,
      memoryId,
      memoryVersionId,
    });
    if (params.uri !== uri) throw new Error(GOVERNED_MEMORY_URI_ERROR);
    return {
      kind: "contact",
      namespaceKey,
      userId,
      rootUri: buildGovernedContactChannelMemoryRootUri({
        namespaceKey,
        contactId,
        channel,
      }),
      contactId,
      channel,
      uri,
      memoryId,
      memoryVersionId,
    };
  }

  if (
    segments.length === 5
    && segments[0] === "representative-experience"
    && segments[1] === "memories"
    && segments[3] === "versions"
  ) {
    const memoryId = requireGovernedMemorySegmentForUri(segments[2]);
    const memoryVersionId = requireGovernedMemoryVersionFilename(segments[4]);
    const uri = buildGovernedRepresentativeExperienceVersionUri({
      namespaceKey,
      memoryId,
      memoryVersionId,
    });
    if (params.uri !== uri) throw new Error(GOVERNED_MEMORY_URI_ERROR);
    return {
      kind: "representative_experience",
      namespaceKey,
      userId,
      rootUri: buildGovernedRepresentativeExperienceRootUri(namespaceKey),
      uri,
      memoryId,
      memoryVersionId,
    };
  }

  throw new Error(GOVERNED_MEMORY_URI_ERROR);
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

/**
 * Builds the immutable, version-scoped projection URI for one KnowledgeAsset.
 *
 * Public recall must never search the legacy representative-wide knowledge
 * root because it is not pinned to a RepresentativeVersion. Each published
 * snapshot therefore gets its own exact asset leaf below the version root.
 */
export function buildRepresentativeVersionKnowledgeAssetUri(
  representativeSlug: string,
  representativeVersionId: string,
  knowledgeAssetId: string,
): string {
  return `${buildRepresentativeVersionResourceRootUri(
    representativeSlug,
    representativeVersionId,
  )}knowledge/${sanitizeSegment(knowledgeAssetId)}.md`;
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

function governedMemoryNamespacePrefix(namespaceKey: string): string {
  return `viking://user/${buildGovernedMemoryManagedUserId(
    namespaceKey,
  )}/memories/delegate/${namespaceKey}/`;
}

function requireCanonicalGovernedMemoryUri(uri: string, expectedPrefix: string): void {
  if (
    typeof uri !== "string"
    || uri !== uri.trim()
    || !uri.startsWith(expectedPrefix)
    || /[\u0000-\u0020\u007f\\%?#]/u.test(uri)
  ) {
    throw new Error(GOVERNED_MEMORY_URI_ERROR);
  }
}

function requireGovernedMemorySegmentForUri(value: string | undefined): string {
  if (!value || !GOVERNED_MEMORY_SEGMENT_PATTERN.test(value)) {
    throw new Error(GOVERNED_MEMORY_URI_ERROR);
  }
  return value;
}

function requireGovernedMemoryChannelForUri(
  value: string | undefined,
): GovernedMemoryChannel {
  if (value === "web" || value === "matrix" || value === "telegram") return value;
  throw new Error(GOVERNED_MEMORY_URI_ERROR);
}

function requireGovernedMemoryVersionFilename(filename: string | undefined): string {
  if (!filename?.endsWith(".md")) throw new Error(GOVERNED_MEMORY_URI_ERROR);
  const versionId = filename.slice(0, -3);
  if (!GOVERNED_MEMORY_SEGMENT_PATTERN.test(versionId)) {
    throw new Error(GOVERNED_MEMORY_URI_ERROR);
  }
  return versionId;
}

function requireGovernedMemorySegment(value: string, field: string): string {
  if (typeof value !== "string" || !GOVERNED_MEMORY_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid governed memory ${field}`);
  }

  return value;
}
