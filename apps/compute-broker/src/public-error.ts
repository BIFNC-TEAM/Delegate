import { ZodError } from "zod";

import { SandboxProviderError } from "./sandbox-provider";
import { SessionError } from "./session-error";

export type PublicBrokerError = {
  statusCode: number;
  code: string;
  logPrivateDetail: boolean;
};

export function toPublicBrokerError(error: unknown): PublicBrokerError {
  if (error instanceof SandboxProviderError) {
    return mapSandboxProviderError(error);
  }

  if (error instanceof SessionError) {
    const code = extractStableErrorCode(error.message);
    if (code) {
      return {
        statusCode: normalizeHttpErrorStatus(error.statusCode),
        code,
        logPrivateDetail: false,
      };
    }
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      code: "invalid_request",
      logPrivateDetail: false,
    };
  }

  if (error instanceof SyntaxError) {
    return {
      statusCode: 400,
      code: "invalid_json",
      logPrivateDetail: false,
    };
  }

  if (error instanceof Error) {
    const sandboxError = sandboxControlErrors[error.message];
    if (sandboxError) return sandboxError;
  }

  return {
    statusCode: 500,
    code: "internal_error",
    logPrivateDetail: true,
  };
}

const sandboxControlErrors: Record<string, PublicBrokerError> = {
  sandbox_phase1_representative_not_allowed: {
    statusCode: 403,
    code: "sandbox_phase1_representative_not_allowed",
    logPrivateDetail: false,
  },
  sandbox_routing_representative_not_test_eligible: {
    statusCode: 403,
    code: "sandbox_phase1_representative_not_allowed",
    logPrivateDetail: false,
  },
  sandbox_runtime_class_not_enabled: {
    statusCode: 409,
    code: "sandbox_runtime_class_not_enabled",
    logPrivateDetail: false,
  },
  sandbox_identity_archived: {
    statusCode: 409,
    code: "sandbox_identity_archived",
    logPrivateDetail: false,
  },
  sandbox_identity_deleted: {
    statusCode: 410,
    code: "sandbox_identity_deleted",
    logPrivateDetail: false,
  },
  sandbox_identity_concurrent_change: {
    statusCode: 409,
    code: "sandbox_identity_concurrent_change",
    logPrivateDetail: false,
  },
  sandbox_provider_not_configured: {
    statusCode: 503,
    code: "sandbox_provider_unavailable",
    logPrivateDetail: true,
  },
  sandbox_provider_migration_required: {
    statusCode: 409,
    code: "sandbox_provider_migration_required",
    logPrivateDetail: false,
  },
  sandbox_provider_operation_fence_lost: {
    statusCode: 409,
    code: "sandbox_creation_pending_reconciliation",
    logPrivateDetail: false,
  },
};

function mapSandboxProviderError(error: SandboxProviderError): PublicBrokerError {
  switch (error.code) {
    case "POLICY_UNSUPPORTED":
      return { statusCode: 409, code: "sandbox_policy_unsupported", logPrivateDetail: false };
    case "RUNTIME_NOT_FOUND":
      return { statusCode: 409, code: "sandbox_runtime_unavailable", logPrivateDetail: false };
    case "COMMAND_TIMEOUT":
      return { statusCode: 504, code: "sandbox_command_timeout", logPrivateDetail: false };
    case "OUTPUT_LIMIT":
      return { statusCode: 413, code: "sandbox_output_limit", logPrivateDetail: false };
    case "AMBIGUOUS_CREATE":
      return { statusCode: 503, code: "sandbox_creation_pending_reconciliation", logPrivateDetail: false };
    case "THROTTLED":
    case "TRANSPORT_TIMEOUT":
    case "REMOTE_5XX":
      return { statusCode: 503, code: "sandbox_provider_unavailable", logPrivateDetail: false };
    case "AUTH_INVALID":
    case "CONFIG_INVALID":
      return { statusCode: 503, code: "sandbox_provider_unavailable", logPrivateDetail: true };
  }
}

function extractStableErrorCode(message: string): string | null {
  return /^([a-z][a-z0-9_]{0,79})(?::|$)/u.exec(message)?.[1] ?? null;
}

function normalizeHttpErrorStatus(statusCode: number): number {
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 500;
}
