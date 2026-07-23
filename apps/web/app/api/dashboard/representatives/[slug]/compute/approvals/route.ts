import { NextResponse } from "next/server";

import { getRepresentativeComputeApprovals } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  try {
    const snapshot = await getRepresentativeComputeApprovals(slug);
    if (!snapshot) {
      return withPrivateNoStore(
        NextResponse.json({ error: "Representative not found." }, { status: 404 }),
      );
    }

    return withPrivateNoStore(NextResponse.json(snapshot));
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return withPrivateNoStore(NextResponse.json(
      { error: "Failed to load compute approvals." },
      { status: 500 },
    ));
  }
}
