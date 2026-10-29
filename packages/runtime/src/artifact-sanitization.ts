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
    for (const [index, piiPattern] of piiPatterns.entries()) {
      // Protect recognized numeric evidence BEFORE matching: a phone candidate
      // must not span a date and an adjacent value. Email matching is unaffected.
      const evidence = index === 0 ? [] : [...calendarDateRanges(sanitized), ...percentageNumberRanges(sanitized)];
      let candidates = sanitized;
      for (const [start, end] of evidence) {
        candidates = candidates.slice(0, start) + "\0".repeat(end - start) + candidates.slice(end);
      }
      for (const match of [...candidates.matchAll(piiPattern)].reverse()) {
        findings.push({ code: "pii_redacted", path: path || "/" });
        sanitized = sanitized.slice(0, match.index) + "[REDACTED_PII]" + sanitized.slice(match.index + match[0].length);
      }
    }
    if (/(?:ignore|bypass|override).{0,40}(?:system|instruction|policy|prompt)|忽略.{0,24}(?:系统|规则|指令)/iu.test(sanitized)) {
      findings.push({ code: "prompt_injection_detected", path: path || "/" });
    }
    return sanitized;
  }
  return value;
}

function calendarDateRanges(value: string): Array<[number, number]> {
  const pattern = /(?<![A-Za-z0-9])([12]\d{3}-\d{2}-\d{2})(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?(?![A-Za-z0-9])/gu;
  return [...value.matchAll(pattern)].flatMap(match => {
    const calendar = match[1]!;
    const date = new Date(`${calendar}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === calendar
      ? [[match.index!, match.index! + match[0].length] as [number, number]] : [];
  });
}

function percentageNumberRanges(value: string): Array<[number, number]> {
  const pattern = /(?<![A-Za-z0-9])[-+]?\d+\.\d+(?:(?:\s+|(?=[+-]))[-+]?\d+\.\d+){1,4}\s*(?:[（(][-+]?\d+(?:\.\d+)?%[）)]|%)/gu;
  return [...value.matchAll(pattern)].map(match => [match.index!, match.index! + match[0].length]);
}

function escapePointer(value: string) {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}
