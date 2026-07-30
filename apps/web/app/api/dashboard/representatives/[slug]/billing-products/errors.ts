import { NextResponse } from "next/server";

import { OwnerBillingProductError } from "@delegate/web-data";

import { withPrivateNoStore } from "../../../../private-response";
import { dashboardAuthErrorResponse } from "../../../auth";

export function dashboardBillingProductErrorResponse(error: unknown) {
  const authResponse = dashboardAuthErrorResponse(error);
  if (authResponse) return authResponse;
  if (error instanceof OwnerBillingProductError) {
    return privateJson(
      {
        error: error.message,
        code: error.code,
        ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      },
      error.statusCode,
    );
  }
  return privateJson(
    {
      error: "The service package request could not be completed.",
      code: "billing_product_internal_error",
    },
    500,
  );
}

export function privateBillingProductJson(
  body: unknown,
  status = 200,
) {
  return privateJson(body, status);
}

function privateJson(body: unknown, status: number) {
  return withPrivateNoStore(
    NextResponse.json(body, { status }),
  );
}
