import { ZodError } from "zod";

import { SessionError } from "./session-error";

export type PublicBrokerError = {
  statusCode: number;
  code: string;
  logPrivateDetail: boolean;
};

export function toPublicBrokerError(error: unknown): PublicBrokerError {
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

  return {
    statusCode: 500,
    code: "internal_error",
    logPrivateDetail: true,
  };
}

function extractStableErrorCode(message: string): string | null {
  return /^([a-z][a-z0-9_]{0,79})(?::|$)/u.exec(message)?.[1] ?? null;
}

function normalizeHttpErrorStatus(statusCode: number): number {
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 500;
}
