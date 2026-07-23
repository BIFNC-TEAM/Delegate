export const mcpHealthFailureCodes = [
  "mcp_binding_cross_origin_request_blocked",
  "mcp_binding_disabled",
  "mcp_binding_has_no_currently_granted_tools",
  "mcp_binding_invalid_url",
  "mcp_binding_non_public_endpoint_blocked",
  "mcp_binding_not_found",
  "mcp_binding_not_granted_by_published_version",
  "mcp_binding_reference_required",
  "mcp_binding_requires_public_https_url",
  "mcp_endpoint_not_found",
  "mcp_execution_failed",
  "mcp_execution_plan_not_supported",
  "mcp_request_payload_too_large",
  "mcp_request_payload_unsupported",
  "mcp_response_payload_too_large",
  "mcp_server_unavailable",
  "mcp_timeout",
  "mcp_tool_arguments_invalid",
  "mcp_tool_arguments_too_large",
  "mcp_tool_list_invalid",
  "mcp_tool_list_too_large",
  "mcp_tool_name_required",
  "mcp_tool_not_allowed_for_binding",
  "mcp_tool_not_exposed_by_server",
  "mcp_tool_result_invalid",
  "mcp_tool_result_too_large",
  "mcp_transport_connection_failed",
  "mcp_transport_failed",
  "mcp_unauthorized",
] as const;

export type McpHealthFailureCode = typeof mcpHealthFailureCodes[number];

const mcpHealthFailureCodeSet = new Set<string>(mcpHealthFailureCodes);

export function normalizeMcpHealthFailureCode(value: unknown): McpHealthFailureCode {
  return typeof value === "string" && mcpHealthFailureCodeSet.has(value)
    ? value as McpHealthFailureCode
    : "mcp_execution_failed";
}
