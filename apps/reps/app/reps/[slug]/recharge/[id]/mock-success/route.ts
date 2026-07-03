import { NextResponse } from "next/server";

import {
  completeMockRechargeOrder,
  getRepresentativeSetupSnapshot,
} from "@delegate/web-data";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;

  try {
    const representative = await getRepresentativeSetupSnapshot(slug);
    if (!representative) {
      return NextResponse.json({ error: "Representative not found." }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const rechargeOrder = await completeMockRechargeOrder(id, {
      ...(typeof body.amountCents === "number" ? { amountCents: body.amountCents } : {}),
      ...(typeof body.providerEventId === "string" && body.providerEventId.trim()
        ? { providerEventId: body.providerEventId.trim() }
        : {}),
    });

    return NextResponse.json({ rechargeOrder });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to complete public mock recharge.",
      },
      { status: 400 },
    );
  }
}
