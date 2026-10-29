import { createHash } from "node:crypto";
import { mcpRecoveryContractSchema, type McpProviderOperation, type McpProviderState, type McpRecoveryContract } from "@delegate/compute-protocol";
import { SessionError } from "./session-error";

export function providerFingerprint(value: unknown): string {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function parseProviderContract(value: unknown): McpRecoveryContract {
  const parsed = mcpRecoveryContractSchema.safeParse(value);
  if (!parsed.success) throw new SessionError(409, "mcp_provider_contract_invalid");
  return parsed.data;
}
export function providerArguments(operation: McpProviderOperation, original: Record<string, unknown>) {
  if (!/^[A-Za-z0-9:_-]{1,160}$/u.test(operation.key) || providerFingerprint(original) !== operation.argumentsHash) throw new SessionError(409, "mcp_provider_request_changed");
  const contract = parseProviderContract(operation.contract);
  const args = structuredClone(original);
  if (contract.mode === "keyed" && contract.key.kind === "argument") {
    if (Object.hasOwn(args, contract.key.name)) throw new SessionError(409, "mcp_provider_managed_key_conflict");
    args[contract.key.name] = operation.key;
  }
  return args;
}
export function classifyProviderReceipt(result: unknown, operation: McpProviderOperation): McpProviderState {
  if (operation.contract.mode !== "keyed") return "unknown";
  const raw = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const receipt = raw.structuredContent && typeof raw.structuredContent === "object" && !Array.isArray(raw.structuredContent)
    ? raw.structuredContent as Record<string, unknown> : {};
  const mapping = operation.contract.receipt;
  if (!Object.hasOwn(receipt, mapping.keyField) || receipt[mapping.keyField] !== operation.key) return "unknown";
  const state = receipt[mapping.stateField];
  if (typeof state !== "string") return "unknown";
  if (mapping.succeeded.includes(state) && raw.isError !== true) return "succeeded";
  if (mapping.failedNoEffect.includes(state)) return "failed_no_effect";
  if (mapping.pending.includes(state)) return "pending";
  if (mapping.notFound.includes(state)) return "not_found";
  return "unknown";
}
