import { NextResponse } from "next/server";

import { completeMockRechargeOrder } from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardBillingAccess,
} from "../../../../dashboard/auth";
import { withPrivateNoStore } from "../../../../private-response";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
    return privateJson({ error: "Not found." }, 404);
  }

  try {
    await requireDashboardBillingAccess();
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const order = await completeMockRechargeOrder(id, {
      ...(typeof body.amountCents === "number" ? { amountCents: body.amountCents } : {}),
      ...(typeof body.providerEventId === "string"
        ? { providerEventId: body.providerEventId }
        : {}),
    });

    return privateJson({ order }, 200);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Failed to complete dashboard mock recharge.", error);
    return privateJson({ error: "Failed to complete mock recharge." }, 400);
  }
}

function privateJson(body: unknown, status: number) {
  return withPrivateNoStore(NextResponse.json(body, { status }));
}
