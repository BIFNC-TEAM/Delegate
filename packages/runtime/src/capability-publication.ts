import {
  createLegacyCapabilityCompilerRegistry,
  type CapabilityCompilerRegistry,
  type CapabilityCompileContext,
} from "./capability-compilation";
import {
  CAPABILITY_CANONICALIZATION_VERSION_V3,
  buildCapabilityAvailabilitySnapshotV3,
  capabilitySemanticsV3Schema,
  registerCapabilityDefinitionV3,
  type CapabilityAvailabilitySnapshotV3,
  type CapabilityDefinitionDraftV3,
  type CapabilityDefinitionV3,
  type CapabilitySemanticsV3,
} from "./turn-planning-v3";
import { stableSha256 } from "./turn-planning";

export type CapabilityPublicationTargetV3 =
  | {
      executor: "mcp";
      bindingId: string;
      bindingRevision: number;
      toolName: string;
    }
  | {
      executor: "skill";
      skillSlug: string;
      releaseId: string;
    }
  | { executor: "builtin" | "knowledge" | "compute" };

export type CapabilityPublicationV3 = {
  definition: CapabilityDefinitionV3;
  semantics: CapabilitySemanticsV3;
  semanticHash: string;
  availability: CapabilityAvailabilitySnapshotV3["capabilities"][number];
  searchDocument: string;
  discoveryTextTrust: "server_defined" | "owner_configured" | "untrusted_remote";
  target: CapabilityPublicationTargetV3;
};

export function createCapabilityPublicationV3(input: {
  definition: CapabilityDefinitionDraftV3;
  semantics: CapabilitySemanticsV3;
  availability: Omit<
    CapabilityAvailabilitySnapshotV3["capabilities"][number],
    "capabilityKey" | "capabilityVersion" | "definitionHash"
  >;
  searchTextParts: unknown[];
  discoveryTextTrust: CapabilityPublicationV3["discoveryTextTrust"];
  target: CapabilityPublicationTargetV3;
}): CapabilityPublicationV3 {
  const semantics = normalizeCapabilitySemanticsV3(input.semantics);
  if (input.definition.executor !== input.target.executor) {
    throw new Error("Capability publication target does not match its executor.");
  }
  const semanticHash = stableSha256(semantics);
  const definition = registerCapabilityDefinitionV3({
    ...input.definition,
    semantics,
    canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
  });
  const availability = {
    capabilityKey: definition.key,
    capabilityVersion: definition.version,
    definitionHash: definition.definitionHash,
    ...input.availability,
  };
  // Reuse the authoritative snapshot validator even for a single capability.
  const availabilitySnapshot = buildCapabilityAvailabilitySnapshotV3({
    catalog: {
      protocolVersion: 2,
      canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
      capabilities: [definition],
      catalogHash: stableSha256({
        canonicalizationVersion: CAPABILITY_CANONICALIZATION_VERSION_V3,
        capabilities: [definition],
      }),
    },
    observedAt: availability.checkedAt,
    capabilities: [availability],
  });
  return {
    definition,
    semantics,
    semanticHash,
    availability: availabilitySnapshot.capabilities[0]!,
    searchDocument: buildCapabilitySearchDocumentV3([
      definition.key,
      definition.description,
      ...definition.tags,
      ...semantics.operations,
      ...semantics.evidenceClasses,
      ...semantics.freshnessClasses,
      ...semantics.authorityClasses,
      ...semantics.domains,
      ...semantics.aliases,
      ...input.searchTextParts,
    ]),
    discoveryTextTrust: input.discoveryTextTrust,
    target: input.target,
  };
}

/**
 * Builds bounded, plain discovery text. The result is data for retrieval, not
 * an instruction block, and callers should keep it in an explicitly
 * untrusted Planner section when it contains remote MCP/Skill text.
 */
export function buildCapabilitySearchDocumentV3(parts: unknown[]): string {
  const flattened: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || flattened.length >= 256) return;
    if (typeof value === "string") {
      const normalized = sanitizeDiscoveryText(value);
      if (normalized) flattened.push(normalized);
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 64).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value as Record<string, unknown>)
        .slice(0, 128)
        .forEach(([key, item]) => {
          visit(key, depth + 1);
          visit(item, depth + 1);
        });
    }
  };
  parts.forEach((part) => visit(part, 0));
  return [...new Set(flattened)].join("\n").slice(0, 16_000);
}

export function createCapabilityCompilerRegistryFromPublicationsV3(
  publications: CapabilityPublicationV3[],
): CapabilityCompilerRegistry {
  const byHash = new Map<string, CapabilityPublicationV3>();
  for (const publication of publications) {
    if (
      publication.availability.capabilityKey !== publication.definition.key
      || publication.availability.capabilityVersion !== publication.definition.version
      || publication.availability.definitionHash !== publication.definition.definitionHash
      || publication.target.executor !== publication.definition.executor
    ) {
      throw new Error("Capability publication coordinates are inconsistent.");
    }
    if (byHash.has(publication.definition.definitionHash)) {
      throw new Error(
        `Capability publication ${publication.definition.key} is duplicated.`,
      );
    }
    byHash.set(publication.definition.definitionHash, publication);
  }
  const resolve = (context: CapabilityCompileContext) => {
    const publication = byHash.get(context.definition.definitionHash);
    if (!publication) {
      throw new Error(`Capability publication ${context.definition.key} is not pinned.`);
    }
    if (publication.availability.healthState === "unavailable") {
      throw new Error(`Capability publication ${context.definition.key} is unavailable.`);
    }
    return publication;
  };
  return createLegacyCapabilityCompilerRegistry({
    resolveMcpTarget(context) {
      const publication = resolve(context);
      if (publication.target.executor !== "mcp") {
        throw new Error("Pinned capability publication is not an MCP target.");
      }
      return publication.target;
    },
    resolveSkillRelease(context) {
      const publication = resolve(context);
      if (publication.target.executor !== "skill") {
        throw new Error("Pinned capability publication is not a Skill target.");
      }
      return publication.target;
    },
  });
}

function normalizeCapabilitySemanticsV3(
  input: CapabilitySemanticsV3,
): CapabilitySemanticsV3 {
  const parsed = capabilitySemanticsV3Schema.parse(input);
  return capabilitySemanticsV3Schema.parse({
    operations: normalizeStringSet(parsed.operations),
    evidenceClasses: normalizeStringSet(parsed.evidenceClasses),
    freshnessClasses: normalizeStringSet(parsed.freshnessClasses),
    authorityClasses: normalizeStringSet(parsed.authorityClasses),
    domains: normalizeStringSet(parsed.domains),
    aliases: normalizeStringSet(parsed.aliases),
  });
}

function normalizeStringSet<T extends string>(values: T[]): T[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0) as T[];
}

function sanitizeDiscoveryText(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
}
