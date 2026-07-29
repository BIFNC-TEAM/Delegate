import { NextResponse } from "next/server";

import { OwnerSettingsError } from "@delegate/web-data/owner-settings";

import { withPrivateNoStore } from "../../private-response";
import { dashboardAuthErrorResponse } from "../auth";

export function ownerSettingsErrorResponse(error: unknown) {
  const authResponse = dashboardAuthErrorResponse(error);
  if (authResponse) return authResponse;
  if (error instanceof OwnerSettingsError) {
    return withPrivateNoStore(NextResponse.json(
      {
        error: error.message,
        code: error.code,
        ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      },
      { status: error.statusCode },
    ));
  }
  return withPrivateNoStore(NextResponse.json(
    {
      error: "Failed to update account settings.",
      code: "owner_settings_internal_error",
    },
    { status: 500 },
  ));
}
