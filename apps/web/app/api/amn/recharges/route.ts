import { NextResponse } from "next/server";

import { createMockRechargeOrder } from "@delegate/web-data";

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
    return new NextResponse(null, { status: 404 });
  }
  try {
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

    return NextResponse.json({ order }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create recharge order.",
      },
      { status: 400 },
    );
  }
}
