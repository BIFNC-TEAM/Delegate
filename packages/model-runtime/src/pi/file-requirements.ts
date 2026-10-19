import { agentTextFileOutput } from "@delegate/domain";
import type { PiArtifact, PiEvidenceRequirements } from "./types";

/** Extract only explicit output targets; arbitrary task intent still needs semantic review. */
export function inferOutputFiles(userText: string): NonNullable<PiEvidenceRequirements["outputFiles"]> {
  const segments = [...userText.matchAll(/(?:生成|导出|交付|generate\b|export\b|deliver\b)([^。！？!?;；\n]{0,180})/giu)];
  const files: NonNullable<PiEvidenceRequirements["outputFiles"]> = [];
  for (const [, segment] of segments) {
    if (!segment) continue;
    // Alternatives and conversions involving an input file need clarification or
    // a trusted host contract; do not treat every mentioned extension as output.
    if (/(?:或者|或|\bor\b|读取|读入|输入|附件|\binput\b|\bfrom\b)/iu.test(segment)) continue;
    const names = [...segment.matchAll(/(?<![\w./-])([a-zA-Z0-9][a-zA-Z0-9_.-]{0,145}\.([a-zA-Z][a-zA-Z0-9]{0,11}))(?![\w.-])/gu)];
    if (names.length) {
      files.push(...names.flatMap(match => match[1] && match[2] ? [{ fileName: match[1], format: match[2].toLowerCase() }] : []));
      continue;
    }
    const aliases: Record<string, string> = { text: "txt", markdown: "md", excel: "xlsx" };
    const formats = [...segment.matchAll(/\b(txt|text|markdown|md|csv|json|pdf|xlsx|xls|excel|png|jpg|jpeg|docx|zip)\b/giu)]
      .flatMap(match => match[1] ? [aliases[match[1].toLowerCase()] ?? match[1].toLowerCase()] : []);
    for (const format of new Set(formats)) files.push({ format });
  }
  return [...new Map(files.map(file => [JSON.stringify(file), file])).values()];
}

/** Metadata gate only: the adapter must already validate bytes and audience access. */
export function isDeliverableArtifact(artifact: PiArtifact, toolName: string): boolean {
  if (!artifact.id || !artifact.fileName || !artifact.url || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) return false;
  try {
    if (!artifact.url.trim() || !["http:", "https:"].includes(new URL(artifact.url, "https://delegate.invalid").protocol)) return false;
  } catch { return false; }
  const format = artifact.fileName.split(".").at(-1)?.toLowerCase() ?? "";
  const mime = artifact.mimeType.split(";")[0]?.trim().toLowerCase();
  const expectedMime = agentTextFileOutput.formats[format as keyof typeof agentTextFileOutput.formats];
  if (expectedMime) return mime === expectedMime && artifact.sizeBytes <= agentTextFileOutput.maximumBytes;
  const screenshots: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
  return toolName === "browse_in_sandbox" && screenshots[format] === mime;
}

export function matchesOutputRequirement(artifact: PiArtifact, required: { format: string; fileName?: string }): boolean {
  return artifact.fileName.split(".").at(-1)?.toLowerCase() === required.format
    && (!required.fileName || artifact.fileName === required.fileName);
}
