import { createHash } from "node:crypto";

import { z } from "zod";

export const sandboxProviderKinds = ["docker", "daytona", "tencent"] as const;
export type SandboxProviderKind = (typeof sandboxProviderKinds)[number];
export type SandboxRoutingMode = "legacy" | "manual_poc";

const providerSchema = z.enum(sandboxProviderKinds);
const representativeIdSchema = z.string().trim().min(1).max(191).regex(/^[A-Za-z0-9_-]+$/);
const routingDocumentSchema = z.object({
  version: z.literal(1),
  default: providerSchema,
  newIdentityEnabled: z.object({
    docker: z.boolean(),
    daytona: z.boolean(),
    tencent: z.boolean(),
  }).strict(),
  phase1AllowedRepresentativeIds: z.array(representativeIdSchema).max(1_000),
  representatives: z.record(representativeIdSchema, providerSchema),
}).strict();

export type SandboxRoutingDocument = z.infer<typeof routingDocumentSchema>;

export type ParsedSandboxRouting = {
  mode: "manual_poc";
  document: SandboxRoutingDocument;
  digest: string;
  allowedRepresentativeIds: ReadonlySet<string>;
};

export type SandboxRoutingRepresentative = {
  id: string;
  sandboxTestEligible: boolean;
  active: boolean;
};

const MAX_ROUTING_DOCUMENT_BYTES = 64 * 1024;

export function parseSandboxRoutingConfig(input: {
  mode: SandboxRoutingMode;
  rawDocument?: string | undefined;
  nodeEnv?: string | undefined;
}): ParsedSandboxRouting | null {
  if (input.mode === "legacy") return null;

  const raw = input.rawDocument?.trim();
  if (!raw) throw new Error("sandbox_routing_document_required");
  if (Buffer.byteLength(raw, "utf8") > MAX_ROUTING_DOCUMENT_BYTES) {
    throw new Error("sandbox_routing_document_too_large");
  }

  assertNoDuplicateJsonKeys(raw);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("sandbox_routing_document_invalid_json");
  }

  const parsed = routingDocumentSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("sandbox_routing_document_invalid");
  const document = parsed.data;
  const allowedRepresentativeIds = new Set(document.phase1AllowedRepresentativeIds);
  if (allowedRepresentativeIds.size !== document.phase1AllowedRepresentativeIds.length) {
    throw new Error("sandbox_routing_allowlist_duplicate");
  }
  const overrideEntries = Object.entries(document.representatives);
  if (overrideEntries.length > 1_000) throw new Error("sandbox_routing_overrides_too_many");
  for (const [representativeId, provider] of overrideEntries) {
    if (!allowedRepresentativeIds.has(representativeId)) {
      throw new Error("sandbox_routing_override_not_allowlisted");
    }
    if (!document.newIdentityEnabled[provider]) {
      throw new Error("sandbox_routing_override_provider_disabled");
    }
  }
  if (!document.newIdentityEnabled[document.default]) {
    throw new Error("sandbox_routing_default_provider_disabled");
  }

  if (input.nodeEnv === "production") {
    if (
      document.default === "docker" ||
      document.newIdentityEnabled.docker ||
      overrideEntries.some(([, provider]) => provider === "docker")
    ) {
      throw new Error("sandbox_routing_docker_forbidden_in_production");
    }
  }

  const canonical = canonicalJson(document);
  return {
    mode: "manual_poc",
    document,
    digest: createHash("sha256").update(`routing:v1:${canonical}`).digest("hex"),
    allowedRepresentativeIds,
  };
}

export function resolveProviderForNewIdentity(
  routing: ParsedSandboxRouting,
  representativeId: string,
): { provider: SandboxProviderKind; decisionSource: "manual_override" | "default" } {
  if (!routing.allowedRepresentativeIds.has(representativeId)) {
    throw new Error("sandbox_phase1_representative_not_allowed");
  }
  const override = routing.document.representatives[representativeId];
  const provider = override ?? routing.document.default;
  if (!routing.document.newIdentityEnabled[provider]) {
    throw new Error("sandbox_provider_new_identity_disabled");
  }
  return {
    provider,
    decisionSource: override ? "manual_override" : "default",
  };
}

export function validateSandboxRoutingRepresentatives(
  routing: ParsedSandboxRouting,
  representatives: readonly SandboxRoutingRepresentative[],
) {
  const byId = new Map(representatives.map((representative) => [representative.id, representative]));
  for (const representativeId of routing.allowedRepresentativeIds) {
    const representative = byId.get(representativeId);
    if (!representative) throw new Error("sandbox_routing_representative_missing");
    if (!representative.active) throw new Error("sandbox_routing_representative_inactive");
    if (!representative.sandboxTestEligible) {
      throw new Error("sandbox_routing_representative_not_test_eligible");
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function assertNoDuplicateJsonKeys(raw: string) {
  let index = 0;

  const skipWhitespace = () => {
    while (/\s/u.test(raw[index] ?? "")) index += 1;
  };

  const parseString = () => {
    const start = index;
    if (raw[index] !== '"') throw new Error("sandbox_routing_document_invalid_json");
    index += 1;
    while (index < raw.length) {
      if (raw[index] === "\\") {
        index += 2;
        continue;
      }
      if (raw[index] === '"') {
        index += 1;
        try {
          return JSON.parse(raw.slice(start, index)) as string;
        } catch {
          throw new Error("sandbox_routing_document_invalid_json");
        }
      }
      index += 1;
    }
    throw new Error("sandbox_routing_document_invalid_json");
  };

  const parseValue = (): void => {
    skipWhitespace();
    const current = raw[index];
    if (current === "{") return parseObject();
    if (current === "[") return parseArray();
    if (current === '"') {
      parseString();
      return;
    }
    const match = raw.slice(index).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u);
    if (!match) throw new Error("sandbox_routing_document_invalid_json");
    index += match[0].length;
  };

  const parseObject = (): void => {
    index += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (raw[index] === "}") {
      index += 1;
      return;
    }
    while (index < raw.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) throw new Error("sandbox_routing_duplicate_key");
      keys.add(key);
      skipWhitespace();
      if (raw[index] !== ":") throw new Error("sandbox_routing_document_invalid_json");
      index += 1;
      parseValue();
      skipWhitespace();
      if (raw[index] === "}") {
        index += 1;
        return;
      }
      if (raw[index] !== ",") throw new Error("sandbox_routing_document_invalid_json");
      index += 1;
    }
    throw new Error("sandbox_routing_document_invalid_json");
  };

  const parseArray = (): void => {
    index += 1;
    skipWhitespace();
    if (raw[index] === "]") {
      index += 1;
      return;
    }
    while (index < raw.length) {
      parseValue();
      skipWhitespace();
      if (raw[index] === "]") {
        index += 1;
        return;
      }
      if (raw[index] !== ",") throw new Error("sandbox_routing_document_invalid_json");
      index += 1;
    }
    throw new Error("sandbox_routing_document_invalid_json");
  };

  parseValue();
  skipWhitespace();
  if (index !== raw.length) throw new Error("sandbox_routing_document_invalid_json");
}
