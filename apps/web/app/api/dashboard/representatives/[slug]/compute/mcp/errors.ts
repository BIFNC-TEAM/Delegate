import { NextResponse } from "next/server";

import {
  McpBindingConflictError,
  McpBindingOperationError,
} from "@delegate/web-data";

export function mcpBindingApiErrorResponse(
  error: unknown,
  fallbackMessage: string,
) {
  if (error instanceof McpBindingConflictError) {
    return NextResponse.json(
      { error: error.publicMessage },
      { status: error.statusCode },
    );
  }
  if (error instanceof McpBindingOperationError) {
    return NextResponse.json(
      { error: error.publicMessage },
      { status: error.statusCode },
    );
  }

  return NextResponse.json(
    { error: fallbackMessage },
    { status: 500 },
  );
}
