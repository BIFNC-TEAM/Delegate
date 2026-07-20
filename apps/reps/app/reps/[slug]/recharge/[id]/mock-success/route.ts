import { NextResponse } from "next/server";

import {
  completeMockRechargeOrder,
  getPublicRepresentativeRuntime,
} from "@delegate/web-data";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;

  try {
    const runtime = await getPublicRepresentativeRuntime(slug);
    if (runtime.status !== "available") return NextResponse.json({ error: "Representative is not publicly available." }, { status: runtime.status === "paused" ? 423 : 404 });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const rechargeOrder = await completeMockRechargeOrder(id, {
      ...(typeof body.amountCents === "number" ? { amountCents: body.amountCents } : {}),
      ...(typeof body.providerEventId === "string" && body.providerEventId.trim()
        ? { providerEventId: body.providerEventId.trim() }
        : {}),
    });

    return NextResponse.json({ rechargeOrder });
  } catch (error) {
    console.error("Failed to complete public mock recharge.", error);
    return NextResponse.json(
      {
        error: "模拟支付确认失败，请刷新后重试；如果问题持续，请联系代表主人检查支付配置。",
      },
      { status: 400 },
    );
  }
}
