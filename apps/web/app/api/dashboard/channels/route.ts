import { NextResponse } from "next/server";

import {
  getOwnerChannelManagementSnapshot,
  provisionOwnerMatrixChannel,
} from "@delegate/web-data";

import { requireDashboardApiOwnerSession } from "../auth";
import { channelManagementErrorResponse } from "./errors";
import { resolveChannelRequestMetadata } from "./request-metadata";

export async function GET() {
  try {
    const session = await requireDashboardApiOwnerSession();
    const snapshot = await getOwnerChannelManagementSnapshot({
      ownerId: session?.ownerId ?? "local-owner",
    });
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return channelManagementErrorResponse(
      error,
      "Failed to load workspace channels.",
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const body = (await request.json().catch(() => null)) as {
      channel?: unknown;
      representativeId?: unknown;
    } | null;
    if (
      body?.channel !== "MATRIX"
      || typeof body.representativeId !== "string"
      || !body.representativeId.trim()
    ) {
      return NextResponse.json(
        { error: "channel=MATRIX and representativeId are required." },
        { status: 400 },
      );
    }
    const actorId = session?.ownerId ?? "local-owner";
    const requestMetadata = resolveChannelRequestMetadata(request);
    const provisioned = await provisionOwnerMatrixChannel({
      ownerId: actorId,
      actorId,
      representativeId: body.representativeId,
      ...requestMetadata,
    });
    return NextResponse.json(
      { ...provisioned, requestId: requestMetadata.requestId },
      {
        status: 201,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    return channelManagementErrorResponse(
      error,
      "Failed to provision Matrix channel.",
    );
  }
}
