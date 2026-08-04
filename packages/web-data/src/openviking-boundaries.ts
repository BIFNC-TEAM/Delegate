import {
  assertCanonicalOpenVikingResourceUri,
  sanitizeVikingSegment,
  type OpenVikingClient,
  type OpenVikingDocumentSpec,
} from "@delegate/openviking";

const LEGACY_MEMORY_SEGMENT_PATTERN = /^[a-z0-9._-]+$/u;
const LEGACY_CONTACT_MEMORY_CATEGORIES = new Set([
  "profile",
  "preferences",
  "entities",
  "events",
]);
const LEGACY_AGENT_MEMORY_CATEGORIES = new Set(["cases", "patterns"]);

export class LegacyOpenVikingMemoryUriError extends Error {
  constructor() {
    super("Legacy OpenViking memory deletion refused an out-of-scope or non-canonical URI.");
    this.name = "LegacyOpenVikingMemoryUriError";
  }
}

export async function syncRepresentativeResourceDocumentToOpenViking(params: {
  client: OpenVikingClient;
  document: OpenVikingDocumentSpec;
  expectedRootUri: string;
  timeoutSeconds: number;
}): Promise<void> {
  if (
    params.document.contextType !== "resource"
    || params.document.scope !== "representative"
  ) {
    throw new Error(
      "Published representative knowledge sync accepts representative resource documents only.",
    );
  }

  assertCanonicalOpenVikingResourceUri(params.expectedRootUri);
  assertCanonicalOpenVikingResourceUri(params.document.uri);
  if (
    !params.expectedRootUri.endsWith("/")
    || params.document.uri === params.expectedRootUri
    || !params.document.uri.startsWith(params.expectedRootUri)
  ) {
    throw new Error("Published representative knowledge URI is outside its pinned version root.");
  }

  const temp = await params.client.tempUpload({
    filename: params.document.filename,
    content: params.document.content,
  });

  await params.client.addResource({
    ...(temp.temp_file_id ? { tempFileId: temp.temp_file_id } : {}),
    ...(temp.temp_path ? { tempPath: temp.temp_path } : {}),
    to: params.document.uri,
    reason: params.document.reason,
    instruction: "Delegate representative public knowledge sync",
    wait: true,
    timeout: params.timeoutSeconds,
  });
}

export function assertLegacyOpenVikingMemoryUriForRepresentative(params: {
  representativeSlug: string;
  uri: string;
}): void {
  const representativeSegment = sanitizeVikingSegment(params.representativeSlug);
  const userPrefix = `viking://user/memories/delegate/${representativeSegment}/`;
  const agentPrefix = `viking://agent/memories/delegate/${representativeSegment}/`;

  if (
    typeof params.uri !== "string"
    || params.uri !== params.uri.trim()
    || /[\u0000-\u0020\u007f\\%?#]/u.test(params.uri)
  ) {
    throw new LegacyOpenVikingMemoryUriError();
  }

  if (params.uri.startsWith(userPrefix)) {
    const segments = requireCanonicalLegacyMemoryLeaf(params.uri.slice(userPrefix.length), 3);
    if (!LEGACY_CONTACT_MEMORY_CATEGORIES.has(segments[1]!)) {
      throw new LegacyOpenVikingMemoryUriError();
    }
    return;
  }

  if (params.uri.startsWith(agentPrefix)) {
    const segments = requireCanonicalLegacyMemoryLeaf(params.uri.slice(agentPrefix.length), 2);
    if (!LEGACY_AGENT_MEMORY_CATEGORIES.has(segments[0]!)) {
      throw new LegacyOpenVikingMemoryUriError();
    }
    return;
  }

  throw new LegacyOpenVikingMemoryUriError();
}

function requireCanonicalLegacyMemoryLeaf(suffix: string, segmentCount: number): string[] {
  const segments = suffix.split("/");
  const filename = segments.at(-1) ?? "";
  if (
    segments.length !== segmentCount
    || segments.some(
      (segment) =>
        !segment
        || segment === "."
        || segment === ".."
        || !LEGACY_MEMORY_SEGMENT_PATTERN.test(segment),
    )
    || !filename.endsWith(".md")
    || filename === ".md"
  ) {
    throw new LegacyOpenVikingMemoryUriError();
  }
  return segments;
}
