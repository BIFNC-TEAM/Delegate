import { NextResponse } from "next/server";

import {
  getWorkspaceWalletReconciliationReport,
  WorkspaceWalletReconciliationInputError,
} from "@delegate/web-data";

import { withPrivateNoStore } from "../../../private-response";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess,
} from "../../auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const activeRepresentativeSlug = url.searchParams.get("rep")?.trim() ?? "";
  if (!activeRepresentativeSlug) {
    return privateJson(
      { error: "rep is required." },
      { status: 400 },
    );
  }

  const representative =
    url.searchParams.get("representative")?.trim() || "all";
  const currency = url.searchParams.get("currency")?.trim();

  try {
    const session = await requireDashboardRepresentativeBillingAccess(
      activeRepresentativeSlug,
    );
    const report = await getWorkspaceWalletReconciliationReport({
      ownerId: session.ownerId,
      activeRepresentativeSlug,
      representative,
      ...(currency ? { currency } : {}),
    });
    if (!report) {
      return privateJson(
        { error: "Wallet workspace not found." },
        { status: 404 },
      );
    }

    return privateJson(report);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return withPrivateNoStore(authResponse);
    if (error instanceof WorkspaceWalletReconciliationInputError) {
      return privateJson({ error: error.message }, { status: 400 });
    }
    return privateJson(
      { error: "Failed to load wallet reconciliation report." },
      { status: 500 },
    );
  }
}

function privateJson(
  body: unknown,
  init?: ResponseInit,
) {
  return withPrivateNoStore(NextResponse.json(body, init));
}
