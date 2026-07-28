import { NextResponse } from "next/server";

import {
  listWalletExceptionCases,
  WalletExceptionActionError,
} from "@delegate/web-data";

import { withPrivateNoStore } from "../../../private-response";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess,
} from "../../auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const representativeSlug =
    url.searchParams.get("rep")?.trim() ?? "";
  if (!representativeSlug) {
    return privateJson(
      {
        code: "representative_required",
        error: "An active representative is required.",
      },
      400,
    );
  }

  try {
    const session =
      await requireDashboardRepresentativeBillingAccess(
        representativeSlug,
      );
    const cases = await listWalletExceptionCases({
      ownerId: session.ownerId,
      representativeSlug,
    });
    return privateJson({ cases });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return withPrivateNoStore(authResponse);
    if (error instanceof WalletExceptionActionError) {
      return privateJson(
        { code: error.code, error: error.message },
        error.statusCode,
      );
    }
    console.error("Failed to load wallet exception queue.", {
      code: "wallet_exception_queue_failed",
    });
    return privateJson(
      {
        code: "wallet_exception_queue_failed",
        error: "The wallet exception queue could not be loaded.",
      },
      500,
    );
  }
}

function privateJson(body: unknown, status = 200) {
  return withPrivateNoStore(
    NextResponse.json(body, { status }),
  );
}
