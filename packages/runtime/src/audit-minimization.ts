import { stableSha256 } from "./capability-schema";

/** Opaque correlation only; never retain an external URL, path or content. */
export function auditReference(value: string): string {
  return /^(?:sha256:[a-f0-9]{64}|http:[1-5]\d{2})$/u.test(value)
    ? value
    : stableSha256(value);
}

export function auditErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/^Maximum Agent steps \(\d{1,6}\) reached before a final answer\.$/u.test(message)) return message;
  if (/^(?:operation_failed|operation_timeout|operation_cancelled|model_content_filtered|model_stream_incomplete|model_provider_network_error|model_finish_unknown|model_output_truncated|model_review_invalid)$/u.test(message)) return message;
  // Finite categories only. Never retain provider error text, URLs or payloads.
  if (/Provider finish_reason: content_filter\b/u.test(message)) return "model_content_filtered";
  if (/Provider finish_reason: network_error\b/u.test(message)) return "model_provider_network_error";
  if (/Provider finish_reason:/u.test(message)) return "model_finish_unknown";
  if (/Stream ended without finish_reason/u.test(message)) return "model_stream_incomplete";
  if ((error instanceof Error && error.name === "AbortError") || /\b(?:cancelled|canceled|aborted)\b/iu.test(message)) return "operation_cancelled";
  if (/\b(?:timeout|timed out)\b/iu.test(message)) return "operation_timeout";
  return "operation_failed";
}

export function summarizeAuditArguments(value: unknown): Record<string, number> {
  return { argumentCount: isRecord(value) ? Object.keys(value).length : 0 };
}

const numberFields = new Set(["sourceCount", "resourceCount", "modelCalls", "toolCalls", "attachmentTransferMs", "argumentCount", "skillCount", "deltaCharacters"]);
const referenceFields = new Set(["toolCallId", "artifactId", "resultRef", "queueId", "transferId", "id", "skillId"]);
const labelFields = new Set(["provider", "model", "runtime", "version"]);
const states = new Set(["completed", "failed", "cancelled", "partial", "waiting_approval", "waiting_user", "pending_approval", "queued", "connected", "accepted", "unknown", "found", "missing", "unavailable", "created", "registered"]);

/** Allowlist metadata rather than trying to recognize every possible secret. */
export function minimizeAuditMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (numberFields.has(key) && typeof item === "number" && Number.isFinite(item) && item >= 0) safe[key] = item;
    else if (referenceFields.has(key) && typeof item === "string") safe[key] = auditReference(item);
    else if (labelFields.has(key) && typeof item === "string" && /^[\w./:-]{1,96}$/u.test(item) && !item.includes("://")) safe[key] = item;
    else if (key === "instructionsDigest" && typeof item === "string" && /^(?:sha256:)?[a-f0-9]{64}$/u.test(item)) safe[key] = item;
    else if (key === "recovery" && typeof item === "boolean") safe[key] = item;
    else if (key === "status" && typeof item === "string" && states.has(item)) safe[key] = item;
    else if (key === "error") safe[key] = auditErrorCode(item);
    else if (key === "arguments") Object.assign(safe, summarizeAuditArguments(item));
    else if (key === "skills" && Array.isArray(item)) safe.skillCount = item.length;
  }
  return safe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
