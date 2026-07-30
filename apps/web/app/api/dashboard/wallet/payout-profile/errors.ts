import { NextResponse } from "next/server";

import {
  CreatorPayoutProfileError,
  PayoutDestinationCredentialError,
} from "@delegate/web-data";

import { withPrivateNoStore } from "../../../private-response";
import { dashboardAuthErrorResponse } from "../../auth";

export function payoutProfileErrorResponse(error: unknown) {
  const authResponse = dashboardAuthErrorResponse(error);
  if (authResponse) return authResponse;
  if (error instanceof CreatorPayoutProfileError) {
    return privatePayoutJson(
      {
        error: error.message,
        code: error.code,
      },
      error.statusCode,
    );
  }
  if (error instanceof PayoutDestinationCredentialError) {
    return privatePayoutJson(
      {
        error: "The tokenized payout destination could not be stored.",
        code: "payout_destination_credential_invalid",
      },
      400,
    );
  }
  return privatePayoutJson(
    {
      error: "Failed to update the Creator payout profile.",
      code: "payout_profile_internal_error",
    },
    500,
  );
}

export function privatePayoutJson(body: unknown, status = 200) {
  return withPrivateNoStore(NextResponse.json(body, { status }));
}
