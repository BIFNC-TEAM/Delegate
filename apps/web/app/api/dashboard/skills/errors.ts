import { NextResponse } from "next/server";

import { WorkspaceSkillOperationError } from "@delegate/web-data";

export function workspaceSkillApiErrorResponse(
  error: unknown,
  fallbackMessage: string,
) {
  if (error instanceof WorkspaceSkillOperationError) {
    return NextResponse.json(
      {
        error: error.publicMessage,
        code: error.code,
      },
      { status: error.statusCode },
    );
  }

  return NextResponse.json(
    { error: fallbackMessage },
    { status: 500 },
  );
}
