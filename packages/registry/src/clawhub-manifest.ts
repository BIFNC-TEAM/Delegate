import { parseDocument } from "yaml";

const MAX_SKILL_MANIFEST_BYTES = 200 * 1024;
const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_FRONTMATTER_LINES = 1_000;
const MAX_YAML_INDENT = 48;
const MAX_REQUIREMENT_ITEMS = 32;
const MAX_INSTALL_ITEMS = 16;

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const binaryNamePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const configPathPattern = /^[^\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]{1,256}$/u;
const osNamePattern = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const supportedInstallKinds = new Set(["brew", "node", "go", "uv"]);

export type ClawHubRuntimeRequirements = {
  requiredEnv: string[];
  optionalEnv: string[];
  requiredBins: string[];
  anyBins: string[];
  configPaths: string[];
  operatingSystems: string[];
  installKinds: Array<"brew" | "node" | "go" | "uv">;
  primaryEnv?: string;
  always: boolean;
};

export type ClawHubSkillManifestResult = {
  parsed: boolean;
  metadataPresent: boolean;
  requirements: ClawHubRuntimeRequirements;
  capabilityTags: string[];
  reason?: ClawHubManifestFailureReason;
};

export type ClawHubManifestFailureReason =
  | "manifest.too_large"
  | "manifest.frontmatter_too_large"
  | "manifest.frontmatter_too_deep"
  | "manifest.frontmatter_unterminated"
  | "manifest.frontmatter_invalid"
  | "manifest.requirements_invalid";

const emptyRequirements = (): ClawHubRuntimeRequirements => ({
  requiredEnv: [],
  optionalEnv: [],
  requiredBins: [],
  anyBins: [],
  configPaths: [],
  operatingSystems: [],
  installKinds: [],
  always: false,
});

/**
 * Parses only bounded, declarative OpenClaw runtime metadata. The Markdown body
 * is intentionally ignored and YAML aliases/custom tags are rejected.
 */
export function parseClawHubSkillManifest(source: string): ClawHubSkillManifestResult {
  if (byteLength(source) > MAX_SKILL_MANIFEST_BYTES) {
    return invalidManifest("manifest.too_large");
  }

  const frontmatter = extractFrontmatter(source);
  if (frontmatter.kind === "none") {
    return validManifest(false, emptyRequirements());
  }
  if (frontmatter.kind === "invalid") {
    return invalidManifest(frontmatter.reason);
  }
  if (
    byteLength(frontmatter.value) > MAX_FRONTMATTER_BYTES
    || frontmatter.value.split(/\r?\n/u).length > MAX_FRONTMATTER_LINES
  ) {
    return invalidManifest("manifest.frontmatter_too_large");
  }
  if (
    frontmatter.value
      .split(/\r?\n/u)
      .some((line) => (line.match(/^[ \t]*/u)?.[0].replace(/\t/gu, "    ").length ?? 0) > MAX_YAML_INDENT)
    || exceedsFlowNesting(frontmatter.value, 32)
  ) {
    return invalidManifest("manifest.frontmatter_too_deep");
  }

  try {
    const document = parseDocument(frontmatter.value, {
      customTags: [],
      merge: false,
      prettyErrors: false,
      resolveKnownTags: false,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: "1.2",
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      return invalidManifest("manifest.frontmatter_invalid");
    }

    const root = document.toJS({ maxAliasCount: 0 });
    if (!isRecord(root)) {
      return invalidManifest("manifest.frontmatter_invalid");
    }

    const metadata = root.metadata;
    if (metadata === undefined) {
      return validManifest(false, emptyRequirements());
    }
    if (!isRecord(metadata)) {
      return invalidManifest("manifest.requirements_invalid");
    }

    const openClawMetadata = metadata.openclaw ?? metadata.clawdbot ?? metadata.clawdis;
    if (openClawMetadata === undefined) {
      return validManifest(false, emptyRequirements());
    }
    if (!isRecord(openClawMetadata)) {
      return invalidManifest("manifest.requirements_invalid");
    }

    const requirements = parseRuntimeRequirements(openClawMetadata);
    if (!requirements) {
      return invalidManifest("manifest.requirements_invalid");
    }
    return validManifest(true, requirements);
  } catch {
    return invalidManifest("manifest.frontmatter_invalid");
  }
}

function parseRuntimeRequirements(metadata: Record<string, unknown>): ClawHubRuntimeRequirements | null {
  const requires = metadata.requires;
  if (requires !== undefined && !isRecord(requires)) {
    return null;
  }

  const requiredEnv = parseStringArray(requires?.env, {
    maxItems: MAX_REQUIREMENT_ITEMS,
    pattern: envNamePattern,
  });
  const requiredBins = parseStringArray(requires?.bins, {
    maxItems: MAX_REQUIREMENT_ITEMS,
    pattern: binaryNamePattern,
  });
  const anyBins = parseStringArray(requires?.anyBins, {
    maxItems: MAX_REQUIREMENT_ITEMS,
    pattern: binaryNamePattern,
  });
  const configPaths = parseStringArray(requires?.config, {
    maxItems: MAX_REQUIREMENT_ITEMS,
    pattern: configPathPattern,
  });
  const operatingSystems = parseStringArray(metadata.os, {
    lowercase: true,
    maxItems: MAX_REQUIREMENT_ITEMS,
    pattern: osNamePattern,
  });
  if (!requiredEnv || !requiredBins || !anyBins || !configPaths || !operatingSystems) {
    return null;
  }

  const envVars = parseEnvironmentVariables(metadata.envVars);
  const installKinds = parseInstallKinds(metadata.install);
  if (!envVars || !installKinds) {
    return null;
  }

  const primaryEnv = metadata.primaryEnv === undefined
    ? undefined
    : normalizeMatchingString(metadata.primaryEnv, envNamePattern);
  if (metadata.primaryEnv !== undefined && !primaryEnv) {
    return null;
  }
  if (metadata.always !== undefined && typeof metadata.always !== "boolean") {
    return null;
  }

  const allRequiredEnv = uniqueSorted([
    ...requiredEnv,
    ...envVars.required,
    ...(primaryEnv ? [primaryEnv] : []),
  ]);
  const allOptionalEnv = uniqueSorted(envVars.optional)
    .filter((name) => !allRequiredEnv.includes(name));
  if (
    allRequiredEnv.length > MAX_REQUIREMENT_ITEMS
    || allOptionalEnv.length > MAX_REQUIREMENT_ITEMS
    || allRequiredEnv.length + allOptionalEnv.length > MAX_REQUIREMENT_ITEMS
  ) {
    return null;
  }

  return {
    requiredEnv: allRequiredEnv,
    optionalEnv: allOptionalEnv,
    requiredBins,
    anyBins,
    configPaths,
    operatingSystems,
    installKinds,
    ...(primaryEnv ? { primaryEnv } : {}),
    always: metadata.always === true,
  };
}

function parseEnvironmentVariables(
  value: unknown,
): { required: string[]; optional: string[] } | null {
  if (value === undefined) {
    return { required: [], optional: [] };
  }
  if (!Array.isArray(value) || value.length > MAX_REQUIREMENT_ITEMS) {
    return null;
  }

  const required: string[] = [];
  const optional: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const name = normalizeMatchingString(item.name, envNamePattern);
    if (!name || (item.required !== undefined && typeof item.required !== "boolean")) {
      return null;
    }
    if (item.required === false) {
      optional.push(name);
    } else {
      required.push(name);
    }
  }
  return {
    required: uniqueSorted(required),
    optional: uniqueSorted(optional),
  };
}

function parseInstallKinds(
  value: unknown,
): Array<"brew" | "node" | "go" | "uv"> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_INSTALL_ITEMS) return null;

  const kinds: Array<"brew" | "node" | "go" | "uv"> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.kind !== "string") return null;
    const kind = item.kind.trim().toLowerCase();
    if (!supportedInstallKinds.has(kind)) return null;
    kinds.push(kind as "brew" | "node" | "go" | "uv");
  }
  return uniqueSorted(kinds);
}

function parseStringArray(
  value: unknown,
  options: { maxItems: number; pattern: RegExp; lowercase?: boolean },
): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > options.maxItems) return null;

  const normalized: string[] = [];
  for (const item of value) {
    const entry = normalizeMatchingString(item, options.pattern, options.lowercase);
    if (!entry) return null;
    normalized.push(entry);
  }
  return uniqueSorted(normalized);
}

function normalizeMatchingString(
  value: unknown,
  pattern: RegExp,
  lowercase = false,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = (lowercase ? value.toLowerCase() : value).trim().normalize("NFC");
  return pattern.test(normalized) ? normalized : undefined;
}

function validManifest(
  metadataPresent: boolean,
  requirements: ClawHubRuntimeRequirements,
): ClawHubSkillManifestResult {
  const capabilityTags: string[] = [];
  if (
    requirements.requiredBins.length > 0
    || requirements.anyBins.length > 0
    || requirements.installKinds.length > 0
  ) {
    capabilityTags.push("exec");
  }
  if (requirements.configPaths.length > 0) capabilityTags.push("read");
  if (requirements.requiredEnv.length > 0 || requirements.optionalEnv.length > 0) {
    capabilityTags.push("env");
  }
  if (requirements.operatingSystems.length > 0) capabilityTags.push("platform");
  if (requirements.always) capabilityTags.push("always");

  return {
    parsed: true,
    metadataPresent,
    requirements,
    capabilityTags: capabilityTags.sort(),
  };
}

function invalidManifest(reason: ClawHubManifestFailureReason): ClawHubSkillManifestResult {
  return {
    parsed: false,
    metadataPresent: false,
    requirements: emptyRequirements(),
    capabilityTags: [],
    reason,
  };
}

function extractFrontmatter(
  source: string,
):
  | { kind: "none" }
  | { kind: "valid"; value: string }
  | { kind: "invalid"; reason: "manifest.frontmatter_unterminated" } {
  const normalized = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const lines = normalized.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") {
    return { kind: "none" };
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line === "---" || line === "...") {
      return { kind: "valid", value: lines.slice(1, index).join("\n") };
    }
  }
  return { kind: "invalid", reason: "manifest.frontmatter_unterminated" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function exceedsFlowNesting(value: string, maximumDepth: number): boolean {
  let depth = 0;
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (const character of value) {
    if (quote) {
      if (quote === "\"" && character === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (character === quote && !escaped) quote = null;
      escaped = false;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (character === "[" || character === "{") {
      depth += 1;
      if (depth > maximumDepth) return true;
    } else if (character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  return false;
}
