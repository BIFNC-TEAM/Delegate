import { describe, expect, it } from "vitest";
import { auditErrorCode, auditReference, minimizeAuditMetadata, summarizeAuditArguments } from "../src/audit-minimization";

describe("audit minimization", () => {
  it.each([
    ["Provider finish_reason: content_filter private payload", "model_content_filtered"],
    ["Provider finish_reason: network_error", "model_provider_network_error"],
    ["Provider finish_reason: PRIVATE_UNKNOWN_VALUE", "model_finish_unknown"],
    ["Stream ended without finish_reason", "model_stream_incomplete"],
    ["model_output_truncated", "model_output_truncated"],
    ["model_review_invalid", "model_review_invalid"],
  ])("retains a safe category through repeated sanitization: %s", (raw, expected) => {
    expect(auditErrorCode(raw)).toBe(expected);
    expect(auditErrorCode(auditErrorCode(raw))).toBe(expected);
    expect(minimizeAuditMetadata({ error: raw })).toEqual({ error: expected });
  });
  it("drops arbitrary carriers including cyclic and nested private content", () => {
    const secret = "SYNTHETIC_UNLABELLED_PRIVATE_TEXT";
    const nested: Record<string, unknown> = { note: secret }; nested.self = nested;
    const value = { arguments: nested, body: nested, skills: [{ instructions: secret }], fileName: secret, sourceCount: 2, recovery: true };
    expect(minimizeAuditMetadata(value)).toEqual({ argumentCount: 2, skillCount: 1, sourceCount: 2, recovery: true });
    expect(nested.note).toBe(secret);
  });

  it("keeps stable opaque references and transport codes without storing URL contents", () => {
    const ref = auditReference("https://user:private@example.invalid/path?secret=private");
    expect(ref).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(auditReference(ref)).toBe(ref);
    expect(auditReference("http:503")).toBe("http:503");
  });

  it("bounds metadata types and exposes error categories instead of raw failures", () => {
    expect(minimizeAuditMetadata({ sourceCount: NaN, resourceCount: -1, model: "https://secret.invalid", error: new Error("private text"), instructionsDigest: "a".repeat(64) })).toEqual({ error: "operation_failed", instructionsDigest: "a".repeat(64) });
    expect(auditErrorCode(new Error("request timed out with private text"))).toBe("operation_timeout");
    expect(summarizeAuditArguments(null)).toEqual({ argumentCount: 0 });
  });
});
