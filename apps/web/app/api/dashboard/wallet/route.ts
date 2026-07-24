import { NextResponse } from "next/server";

import {
  getWorkspaceWalletSnapshot,
  WorkspaceWalletInputError,
  type WorkspaceWalletView,
} from "@delegate/web-data";

import { withPrivateNoStore } from "../../private-response";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess,
} from "../auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const activeRepresentativeSlug = url.searchParams.get("rep")?.trim() ?? "";
  if (!activeRepresentativeSlug) {
    return privateJson(
      { error: "rep is required." },
      { status: 400 },
    );
  }

  const rawLimit = url.searchParams.get("limit")?.trim();
  const limit = rawLimit ? Number(rawLimit) : undefined;

  try {
    const session = await requireDashboardRepresentativeBillingAccess(
      activeRepresentativeSlug,
    );
    const snapshot = await getWorkspaceWalletSnapshot({
      ownerId: session.ownerId,
      activeRepresentativeSlug,
      ...(url.searchParams.get("view")
        ? { view: url.searchParams.get("view")!.trim() as WorkspaceWalletView }
        : {}),
      ...(url.searchParams.get("representative")
        ? { representative: url.searchParams.get("representative")!.trim() }
        : {}),
      ...(url.searchParams.get("currency")
        ? { currency: url.searchParams.get("currency")!.trim() }
        : {}),
      ...(url.searchParams.get("eventType")
        ? { eventType: url.searchParams.get("eventType")!.trim() }
        : {}),
      ...(url.searchParams.get("query")
        ? { query: url.searchParams.get("query")!.trim() }
        : {}),
      ...(url.searchParams.get("from")
        ? { from: url.searchParams.get("from")!.trim() }
        : {}),
      ...(url.searchParams.get("to")
        ? { to: url.searchParams.get("to")!.trim() }
        : {}),
      ...(url.searchParams.get("asOf")
        ? { asOf: url.searchParams.get("asOf")!.trim() }
        : {}),
      ...(url.searchParams.get("cursor")
        ? { cursor: url.searchParams.get("cursor")!.trim() }
        : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (!snapshot) {
      return privateJson(
        { error: "Wallet workspace not found." },
        { status: 404 },
      );
    }
    return privateJson({
      ...snapshot,
      capabilities: {
        mockWithdrawalOperations: process.env.NODE_ENV !== "production",
      },
    });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof WorkspaceWalletInputError) {
      return privateJson({ error: error.message }, { status: 400 });
    }
    return privateJson(
      { error: "Failed to load workspace wallet and billing." },
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
