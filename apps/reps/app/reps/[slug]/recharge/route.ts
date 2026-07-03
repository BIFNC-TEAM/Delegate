import { NextResponse } from "next/server";

import {
  createMockRechargeOrder,
  getRepresentativeSetupSnapshot,
} from "@delegate/web-data";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const representative = await getRepresentativeSetupSnapshot(slug);
    if (!representative) {
      return NextResponse.json({ error: "Representative not found." }, { status: 404 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const audienceId = String(body.audienceId ?? "").trim().toLowerCase();
    const amountCents = Number(body.amountCents ?? 0);
    const idempotencyKey =
      typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : `public_recharge:${slug}:${audienceId}:${amountCents}`;

    if (!audienceId) {
      return NextResponse.json({ error: "audienceId is required." }, { status: 400 });
    }

    const rechargeOrder = await createMockRechargeOrder({
      externalUserId: `web:${slug}:${audienceId}`,
      displayName: typeof body.displayName === "string" ? body.displayName : audienceId,
      amountCents,
      currency: "CNY",
      idempotencyKey,
    });

    return NextResponse.json({ rechargeOrder }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create public recharge order.",
      },
      { status: 400 },
    );
  }
}
