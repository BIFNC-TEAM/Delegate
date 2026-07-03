import { NextResponse } from "next/server";

import { completeMockRechargeOrder } from "@delegate/web-data";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const order = await completeMockRechargeOrder(id, {
      ...(typeof body.amountCents === "number" ? { amountCents: body.amountCents } : {}),
      ...(typeof body.providerEventId === "string"
        ? { providerEventId: body.providerEventId }
        : {}),
    });

    return NextResponse.json({ order });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to complete mock recharge.",
      },
      { status: 400 },
    );
  }
}
