import { canonicalJson, validateJsonSchemaValue } from "./turn-planning";
import type { SuccessContractV3 } from "./turn-planning-v3";

export type TransportOutcomeV3 =
  | "not_started"
  | "response_received"
  | "confirmed_not_sent"
  | "transport_failed"
  | "outcome_unknown";

export type SemanticOutcomeV3 = "succeeded" | "failed" | "partial" | "unknown";

export type ResultSecurityFinding = {
  code: "secret_redacted" | "pii_redacted" | "prompt_injection_detected";
  path: string;
};

export type VerifiedResultPayload = {
  transportOutcome: TransportOutcomeV3;
  semanticOutcome: SemanticOutcomeV3;
  sanitizedOutput?: unknown;
  securityFindings: ResultSecurityFinding[];
  failureCode?: string;
};

export function verifyRawActionResult(input: {
  transportOutcome: TransportOutcomeV3;
  rawOutput?: unknown;
  expectedOutputSchema: Record<string, unknown>;
  successContract?: SuccessContractV3;
  maximumBytes?: number;
  maximumNodes?: number;
  maximumDepth?: number;
}): VerifiedResultPayload {
  if (input.transportOutcome === "outcome_unknown") {
    return {
      transportOutcome: input.transportOutcome,
      semanticOutcome: "unknown",
      securityFindings: [],
      failureCode: "transport_outcome_unknown",
    };
  }
  if (input.transportOutcome !== "response_received") {
    return {
      transportOutcome: input.transportOutcome,
      semanticOutcome: "failed",
      securityFindings: [],
      failureCode: input.transportOutcome === "confirmed_not_sent"
        ? "external_call_not_sent"
        : "transport_failed",
    };
  }
  const limits = {
    maximumBytes: input.maximumBytes ?? 2 * 1024 * 1024,
    maximumNodes: input.maximumNodes ?? 50_000,
    maximumDepth: input.maximumDepth ?? 32,
  };
  const sizeFailure = validatePayloadBounds(input.rawOutput, limits);
  if (sizeFailure) {
    return {
      transportOutcome: input.transportOutcome,
      semanticOutcome: "failed",
      securityFindings: [],
      failureCode: sizeFailure,
    };
  }
  const findings: ResultSecurityFinding[] = [];
  const sanitizedOutput = sanitizeValue(input.rawOutput, "", findings);
  const outputProblems = validateJsonSchemaValue(
    sanitizedOutput,
    input.expectedOutputSchema,
    "/output",
  );
  if (outputProblems.length) {
    return {
      transportOutcome: input.transportOutcome,
      semanticOutcome: "failed",
      sanitizedOutput,
      securityFindings: findings,
      failureCode: "output_schema_invalid",
    };
  }
  const semantic = evaluateSuccessContract(
    sanitizedOutput,
    input.successContract,
  );
  return {
    transportOutcome: input.transportOutcome,
    semanticOutcome: semantic.outcome,
    sanitizedOutput,
    securityFindings: findings,
    ...(semantic.failureCode ? { failureCode: semantic.failureCode } : {}),
  };
}

export function sanitizeUntrustedArtifactPayload(value: unknown): {
  sanitized: unknown;
  securityFindings: ResultSecurityFinding[];
} {
  const securityFindings: ResultSecurityFinding[] = [];
  return {
    sanitized: sanitizeValue(value, "", securityFindings),
    securityFindings,
  };
}

export function normalizeEvidenceBindings(
  bindings: Array<Record<string, unknown>>,
) {
  const scalarKeys = [
    "evidenceId",
    "evidenceClass",
    "sourceActionId",
    "actionResultId",
    "memoryUseItemId",
    "memoryUseRunId",
  ] as const;
  const listKeys = ["goalIds", "sourceKinds"] as const;
  return bindings.map((binding) => ({
    ...Object.fromEntries(
    scalarKeys.flatMap((key) =>
      typeof binding[key] === "string" && binding[key]
        ? [[key, binding[key]]]
        : []),
    ),
    ...Object.fromEntries(listKeys.flatMap((key) => {
      if (!Array.isArray(binding[key])) return [];
      const values = [...new Set(binding[key].flatMap((item) =>
        typeof item === "string" && item.trim() ? [item.trim()] : []))]
        .slice(0, 64);
      return values.length ? [[key, values]] : [];
    })),
  })).filter((binding) => Object.keys(binding).length > 0);
}

export function evaluateSuccessContract(
  output: unknown,
  contract?: SuccessContractV3,
): { outcome: SemanticOutcomeV3; failureCode?: string } {
  if (!contract) return { outcome: "unknown", failureCode: "success_contract_missing" };
  switch (contract.kind) {
    case "success_schema": {
      const problems = validateJsonSchemaValue(output, contract.schema, "/success");
      return problems.length
        ? { outcome: "failed", failureCode: "success_schema_mismatch" }
        : { outcome: "succeeded" };
    }
    case "status_predicate": {
      const value = resolvePointer(output, contract.pointer);
      const passed = contract.operator === "equals"
        ? canonicalJson(value) === canonicalJson(contract.value)
        : Array.isArray(contract.value)
          && contract.value.some((candidate) =>
            canonicalJson(candidate) === canonicalJson(value));
      return passed
        ? { outcome: "succeeded" }
        : { outcome: "failed", failureCode: "success_predicate_failed" };
    }
    case "server_evaluator":
      return evaluateRegisteredServerContract(output, contract);
    case "manual_confirmation":
      return { outcome: "unknown", failureCode: "manual_confirmation_required" };
  }
}

function evaluateRegisteredServerContract(
  output: unknown,
  contract: Extract<SuccessContractV3, { kind: "server_evaluator" }>,
): { outcome: SemanticOutcomeV3; failureCode?: string } {
  if (
    contract.evaluatorId === "mcp.generic_semantic"
    && contract.evaluatorVersion === "1"
  ) return evaluateGenericMcpFailureOnly(output);
  if (
    contract.evaluatorId === "mcp.deepwiki.read_semantic"
    && contract.evaluatorVersion === "1"
  ) return evaluateDeepWikiReadSemanticV1(output);
  if (
    contract.evaluatorId === "mcp.deepwiki.read_semantic"
    && contract.evaluatorVersion === "2"
  ) return evaluateDeepWikiReadSemanticV2(output);
  return { outcome: "unknown", failureCode: "server_evaluator_unavailable" };
}

function evaluateGenericMcpFailureOnly(
  output: unknown,
): { outcome: SemanticOutcomeV3; failureCode?: string } {
  const signals = collectGenericMcpFailureSignals(output);
  if (signals.explicitProtocolError) {
    return { outcome: "failed", failureCode: "mcp_protocol_error_result" };
  }
  if (signals.explicitSemanticFailure) {
    return { outcome: "failed", failureCode: "mcp_semantic_failure_result" };
  }
  // This generic evaluator is intentionally one-sided. It can recognize a
  // bounded set of explicit failures, but absence of those markers is not a
  // business success contract. Third-party tools need an Owner/server-pinned
  // purpose-built contract to reach semantic success.
  return { outcome: "unknown", failureCode: "mcp_success_contract_unverified" };
}

function collectGenericMcpFailureSignals(output: unknown) {
  let explicitProtocolError = false;
  let explicitSemanticFailure = false;
  const visit = (value: unknown, depth: number) => {
    if (depth > 16 || explicitProtocolError) return;
    if (Array.isArray(value)) {
      value.slice(0, 2_000).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (key === "isError") {
          if (nested === true) explicitProtocolError = true;
          continue;
        }
        if (key === "type" || key === "mimeType") continue;
        visit(nested, depth + 1);
      }
      return;
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return;
      if (
        /^(?:error\b[^:\n]{0,120}|failed|failure)\s*(?::|-)|(?:^|:\s*)(?:repository|resource|record|item)\s+not\s+found\b|^(?:not\s+found|does\s+not\s+exist)\b/iu.test(text)
        || /^(?:错误|执行失败|处理失败|未找到|不存在)(?:[：:\s]|$)/u.test(text)
      ) {
        explicitSemanticFailure = true;
      }
      return;
    }
  };
  visit(output, 0);
  return { explicitProtocolError, explicitSemanticFailure };
}

function evaluateDeepWikiReadSemanticV1(
  output: unknown,
): { outcome: SemanticOutcomeV3; failureCode?: string } {
  const record = asRecord(output);
  if (!record || !("result" in record)) {
    return { outcome: "unknown", failureCode: "deepwiki_result_shape_unknown" };
  }
  const extracted = extractDeepWikiTextV1(record["result"]);
  if (extracted.protocolError) {
    return { outcome: "failed", failureCode: "deepwiki_protocol_error_result" };
  }
  if (!extracted.knownShape) {
    return { outcome: "unknown", failureCode: "deepwiki_result_shape_unknown" };
  }
  if (!extracted.texts.length) {
    return { outcome: "unknown", failureCode: "deepwiki_result_empty" };
  }
  if (extracted.texts.some(isDeepWikiBusinessFailureTextV1)) {
    return { outcome: "failed", failureCode: "deepwiki_business_failure" };
  }
  // DeepWiki currently returns free-form text and has been observed to carry
  // business failures while the MCP transport reports success. Length,
  // language, or token density cannot prove semantic success. Until a trusted
  // wrapper supplies a machine-verifiable success field, known failures may be
  // closed as failed but every other text result remains unknown.
  return { outcome: "unknown", failureCode: "deepwiki_success_unproven" };
}

function evaluateDeepWikiReadSemanticV2(
  output: unknown,
): { outcome: SemanticOutcomeV3; failureCode?: string } {
  const record = asRecord(output);
  if (!record || !("result" in record)) {
    return { outcome: "unknown", failureCode: "deepwiki_result_shape_unknown" };
  }
  const extracted = extractDeepWikiTextV1(record["result"]);
  if (extracted.protocolError) {
    return { outcome: "failed", failureCode: "deepwiki_protocol_error_result" };
  }
  if (!extracted.knownShape) {
    return { outcome: "unknown", failureCode: "deepwiki_result_shape_unknown" };
  }
  if (!extracted.texts.length) {
    return { outcome: "unknown", failureCode: "deepwiki_result_empty" };
  }
  if (extracted.texts.some(isDeepWikiBusinessFailureTextV2)) {
    return { outcome: "failed", failureCode: "deepwiki_business_failure" };
  }
  // The endpoint, transport, tool schema, and this evaluator version are all
  // pinned by the server-owned capability policy before execution. For this
  // read-only contract, a known non-empty MCP result without an explicit error
  // is the deliverable; it does not need a second business-state marker.
  return { outcome: "succeeded" };
}

function extractDeepWikiTextV1(value: unknown): {
  knownShape: boolean;
  protocolError: boolean;
  texts: string[];
} {
  if (typeof value === "string") {
    const text = value.trim();
    return { knownShape: true, protocolError: false, texts: text ? [text] : [] };
  }
  const record = asRecord(value);
  if (!record) return { knownShape: false, protocolError: false, texts: [] };
  if (record["isError"] === true) {
    return { knownShape: true, protocolError: true, texts: [] };
  }
  if (typeof record["result"] === "string") {
    const text = record["result"].trim();
    return { knownShape: true, protocolError: false, texts: text ? [text] : [] };
  }
  if (!Array.isArray(record["content"])) {
    return { knownShape: false, protocolError: false, texts: [] };
  }
  const texts: string[] = [];
  for (const item of record["content"].slice(0, 2_000)) {
    const content = asRecord(item);
    if (!content || content["type"] !== "text" || typeof content["text"] !== "string") {
      continue;
    }
    const text = content["text"].trim();
    if (text) texts.push(text);
  }
  return { knownShape: true, protocolError: false, texts };
}

function isDeepWikiBusinessFailureTextV1(value: string) {
  const text = value.normalize("NFKC").trim();
  return text.split(/\r?\n/gu).some((line) => {
    const status = line.trim();
    if (!status) return false;
    const englishFailure = /^(?:error\s+processing\b|error\b[^:\n]{0,120}:|failed\b|failure\b|(?:repository|repo|resource)\s+(?:was\s+)?not\s+found\b|(?:repository|repo)\s+does\s+not\s+exist\b|permission\s+denied\b|unauthori[sz]ed\b|forbidden\b|authentication\s+(?:failed|required)\b|access\s+denied\b|rate\s*limit(?:ed|\s+exceeded)?\b|too\s+many\s+requests\b|temporarily\s+unavailable\b|(?:the\s+)?(?:service|server|upstream)\s+(?:is\s+)?(?:temporarily\s+)?unavailable\b|(?:request\s+)?(?:timed?\s*out|timeout)\b|internal\s+server\s+error\b|bad\s+gateway\b|gateway\s+timeout\b|(?:the\s+)?(?:server\s+)?(?:is\s+)?overload(?:ed)?\b|(?:please\s+)?try\s+again\s+later\b|(?:500|502|503|504)\b)/iu;
    const chineseFailure = /^(?:错误|处理失败|执行失败|仓库不存在|未找到仓库|无权访问|权限不足|未授权|请求过于频繁|服务不可用|请求超时|服务器内部错误|系统繁忙)/u;
    return englishFailure.test(status) || chineseFailure.test(status);
  });
}

function isDeepWikiBusinessFailureTextV2(value: string) {
  const firstLine = value
    .normalize("NFKC")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return false;
  const englishFailure = /^(?:error\s+processing\b|error\b[^:\n]{0,120}:|(?:failed|failure)\s*(?::|-|$)|(?:repository|repo|resource)\s+(?:was\s+)?not\s+found\b|(?:repository|repo)\s+does\s+not\s+exist\b|permission\s+denied\b|unauthori[sz]ed\b|forbidden\b|authentication\s+(?:failed|required)\b|access\s+denied\b|rate\s*limit(?:ed|\s+exceeded)?\b|too\s+many\s+requests\b|temporarily\s+unavailable\b|(?:the\s+)?(?:service|server|upstream)\s+(?:is\s+)?(?:temporarily\s+)?unavailable\b|(?:request\s+)?(?:timed?\s*out|timeout)\b|internal\s+server\s+error\b|bad\s+gateway\b|gateway\s+timeout\b|(?:the\s+)?(?:server\s+)?(?:is\s+)?overload(?:ed)?\b|(?:please\s+)?try\s+again\s+later\b|(?:500|502|503|504)\b)/iu;
  const chineseFailure = /^(?:错误|处理失败|执行失败|仓库不存在|未找到仓库|无权访问|权限不足|未授权|请求过于频繁|服务不可用|请求超时|服务器内部错误|系统繁忙)(?:[：:\s]|$)/u;
  return englishFailure.test(firstLine) || chineseFailure.test(firstLine);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizeValue(
  value: unknown,
  path: string,
  findings: ResultSecurityFinding[],
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
      /(?<!\d)\+?\d[\d\s().-]{7,}\d(?!\d)/gu,
    ];
    for (const piiPattern of piiPatterns) {
      sanitized = sanitized.replace(piiPattern, (match) => {
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

function validatePayloadBounds(
  value: unknown,
  limits: { maximumBytes: number; maximumNodes: number; maximumDepth: number },
) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "result_payload_invalid";
  }
  if (Buffer.byteLength(serialized ?? "", "utf8") > limits.maximumBytes) {
    return "result_payload_too_large";
  }
  let nodes = 0;
  const visit = (current: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > limits.maximumNodes || depth > limits.maximumDepth) return false;
    if (Array.isArray(current)) return current.every((item) => visit(item, depth + 1));
    if (current && typeof current === "object") {
      return Object.entries(current as Record<string, unknown>)
        .every(([key, nested]) => visit(key, depth + 1) && visit(nested, depth + 1));
    }
    return true;
  };
  return visit(value, 0) ? null : "result_payload_too_complex";
}

function resolvePointer(value: unknown, pointer: string) {
  if (!pointer.startsWith("/")) return undefined;
  let current = value;
  for (const segment of pointer.slice(1).split("/").map((item) =>
    item.replace(/~1/gu, "/").replace(/~0/gu, "~"))) {
    if (!current || typeof current !== "object" || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function escapePointer(value: string) {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}
