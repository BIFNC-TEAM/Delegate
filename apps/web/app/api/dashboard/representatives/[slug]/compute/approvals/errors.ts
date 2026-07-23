import { NextResponse } from "next/server";

import {
  ComputeBrokerError,
  WorkspaceSkillOperationError,
} from "@delegate/web-data";

export function computeApprovalApiErrorResponse(error: unknown) {
  if (error instanceof WorkspaceSkillOperationError) {
    return NextResponse.json(
      { error: error.publicMessage, code: error.code },
      { status: error.statusCode },
    );
  }
  if (error instanceof ComputeBrokerError) {
    return NextResponse.json(
      { error: error.publicMessage },
      { status: error.statusCode },
    );
  }

  return NextResponse.json(
    { error: "Failed to resolve compute approval." },
    { status: 500 },
  );
}
