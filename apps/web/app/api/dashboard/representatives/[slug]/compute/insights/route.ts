import { NextResponse } from "next/server";

import { getRepresentativeApprovalInsights } from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }
  const url = new URL(request.url);

  try {
    const approver = readOptionalFilter(url.searchParams.get("approver"));
    const customer = readOptionalFilter(url.searchParams.get("customer"));
    const subagent = readOptionalFilter(url.searchParams.get("subagent"));
    const status = readStatusFilter(url.searchParams.get("status"));
    const snapshot = await getRepresentativeApprovalInsights(slug, {
      ...(approver ? { approver } : {}),
      ...(customer ? { customer } : {}),
      ...(subagent ? { subagent } : {}),
      ...(status ? { status } : {}),
    });

    if (!snapshot) {
      return NextResponse.json({ error: "Representative not found." }, { status: 404 });
    }

    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load compute approval insights.",
      },
      { status: 500 },
    );
  }
}

function readOptionalFilter(value: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function readStatusFilter(value: string | null) {
  switch (value) {
    case "pending":
    case "approved":
    case "rejected":
    case "expired":
      return value;
    default:
      return undefined;
  }
}
