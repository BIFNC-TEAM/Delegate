import { NextResponse } from "next/server";

import { createOrRotateOwnerTelegramBotConnection } from "@delegate/web-data";

import { requireDashboardApiOwnerSession } from "../../auth";
import { channelManagementErrorResponse } from "../errors";
import { resolveChannelRequestMetadata } from "../request-metadata";

const maxTokenLength = 512;
const maxLabelLength = 100;

export async function POST(request: Request) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const body = (await request.json().catch(() => null)) as {
      token?: unknown;
      label?: unknown;
    } | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    if (!token || token.length > maxTokenLength) {
      return NextResponse.json(
        { error: "A valid Telegram Bot token is required." },
        {
          status: 400,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    if (
      body?.label !== undefined
      && (
        typeof body.label !== "string"
        || label.length > maxLabelLength
      )
    ) {
      return NextResponse.json(
        { error: `label must be at most ${maxLabelLength} characters.` },
        {
          status: 400,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }

    const actorId = session?.ownerId ?? "local-owner";
    const requestMetadata = resolveChannelRequestMetadata(request);
    const created = await createOrRotateOwnerTelegramBotConnection({
      ownerId: actorId,
      actorId,
      token,
      ...(label ? { label } : {}),
      ...requestMetadata,
    });
    return NextResponse.json(
      { ...created, requestId: requestMetadata.requestId },
      {
        status: 201,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    return channelManagementErrorResponse(
      error,
      "Failed to verify and add Telegram Bot.",
    );
  }
}
