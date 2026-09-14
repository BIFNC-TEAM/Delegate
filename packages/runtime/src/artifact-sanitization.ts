export type ArtifactSecurityFinding = {
  code: "secret_redacted" | "pii_redacted" | "prompt_injection_detected";
  path: string;
};

export function sanitizeUntrustedArtifactPayload(value: unknown): {
  sanitized: unknown;
  securityFindings: ArtifactSecurityFinding[];
} {
  const securityFindings: ArtifactSecurityFinding[] = [];
  return {
    sanitized: sanitizeValue(value, "", securityFindings),
    securityFindings,
  };
}

function sanitizeValue(
  value: unknown,
  path: string,
  findings: ArtifactSecurityFinding[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, `${path}/${index}`, findings));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(
      ([key, nested]) => {
        const nestedPath = `${path}/${escapePointer(key)}`;
        if (/(?:token|secret|password|cookie|authorization|api[_-]?key|credential)/iu.test(key)) {
          findings.push({ code: "secret_redacted", path: nestedPath });
          return [key, "[REDACTED_SECRET]"];
        }
        if (/(?:id[_-]?card|passport|bank[_-]?card|ssn)/iu.test(key)) {
          findings.push({ code: "pii_redacted", path: nestedPath });
          return [key, "[REDACTED_PII]"];
        }
        return [key, sanitizeValue(nested, nestedPath, findings)];
      },
    ));
  }
  if (typeof value === "string") {
    let sanitized = value;
    const credentialPattern = /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/giu;
    if (credentialPattern.test(sanitized)) {
      findings.push({ code: "secret_redacted", path: path || "/" });
      sanitized = sanitized.replace(credentialPattern, "[REDACTED_SECRET]");
    }
    const piiPatterns = [
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      /\b\d{15}(?:\d{2}[\dXx])?\b/gu,
      /\b\d{3}-?\d{2}-?\d{4}\b/gu,
      /(?<![A-Za-z0-9])\+?\d[\d\s().-]{7,}\d(?!\d)/gu,
    ];
    for (const piiPattern of piiPatterns) {
      sanitized = sanitized.replace(piiPattern, () => {
        findings.push({ code: "pii_redacted", path: path || "/" });
        return "[REDACTED_PII]";
      });
    }
    if (/(?:ignore|bypass|override).{0,40}(?:system|instruction|policy|prompt)|忽略.{0,24}(?:系统|规则|指令)/iu.test(sanitized)) {
      findings.push({ code: "prompt_injection_detected", path: path || "/" });
    }
    return sanitized;
  }
  return value;
}

function escapePointer(value: string) {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}
