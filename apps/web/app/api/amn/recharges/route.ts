import { NextResponse } from "next/server";

import { createMockRechargeOrder } from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardBillingAccess,
} from "../../dashboard/auth";
import { withPrivateNoStore } from "../../private-response";

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
    return privateJson({ error: "Not found." }, 404);
  }
  try {
    await requireDashboardBillingAccess();
    const body = (await request.json()) as Record<string, unknown>;
    const order = await createMockRechargeOrder({
      externalUserId: String(body.externalUserId ?? ""),
      amountCents: Number(body.amountCents ?? 0),
      ...(typeof body.currency === "string" ? { currency: body.currency } : {}),
      ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
      ...(typeof body.telegramUserId === "string"
        ? { telegramUserId: body.telegramUserId }
        : {}),
      ...(typeof body.idempotencyKey === "string"
        ? { idempotencyKey: body.idempotencyKey }
        : {}),
    });

    return privateJson({ order }, 201);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;

    console.error("Failed to create dashboard mock recharge order.", error);
    return privateJson({ error: "Failed to create mock recharge order." }, 400);
  }
}

function privateJson(body: unknown, status: number) {
  return withPrivateNoStore(NextResponse.json(body, { status }));
}
