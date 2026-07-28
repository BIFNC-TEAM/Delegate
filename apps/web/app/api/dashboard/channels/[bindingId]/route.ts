import { NextResponse } from "next/server";

import {
  disconnectOwnerMatrixChannel,
  setOwnerChannelDesiredState,
  unassignOwnerTelegramBotConnection,
} from "@delegate/web-data";

import { requireDashboardApiOwnerSession } from "../../auth";
import { channelManagementErrorResponse } from "../errors";
import { resolveChannelRequestMetadata } from "../request-metadata";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ bindingId: string }> },
) {
  const { bindingId } = await params;
  try {
    const session = await requireDashboardApiOwnerSession();
    const body = (await request.json().catch(() => null)) as {
      desiredState?: unknown;
    } | null;
    if (
      body?.desiredState !== "ACTIVE"
      && body?.desiredState !== "PAUSED"
    ) {
      return NextResponse.json(
        { error: "desiredState must be ACTIVE or PAUSED." },
        {
          status: 400,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    const actorId = session?.ownerId ?? "local-owner";
    const requestMetadata = resolveChannelRequestMetadata(request);
    const binding = await setOwnerChannelDesiredState({
      ownerId: actorId,
      actorId,
      bindingId,
      desiredState: body.desiredState,
      ...requestMetadata,
    });
    return NextResponse.json(
      { binding, requestId: requestMetadata.requestId },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return channelManagementErrorResponse(
      error,
      "Failed to update channel state.",
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ bindingId: string }> },
) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const { bindingId } = await params;
    const searchParams = new URL(request.url).searchParams;
    const channel = searchParams.get("channel")?.trim().toUpperCase();
    const telegramBotConnectionId = searchParams
      .get("telegramBotConnectionId")
      ?.trim();
    const actorId = session?.ownerId ?? "local-owner";
    const requestMetadata = resolveChannelRequestMetadata(request);
    if (channel === "MATRIX") {
      const result = await disconnectOwnerMatrixChannel({
        ownerId: actorId,
        actorId,
        bindingId,
        ...requestMetadata,
      });
      return NextResponse.json(
        {
          bindingId: result.binding.id,
          representativeId: result.binding.representativeId,
          desiredState: result.binding.desiredState,
          changed: result.changed,
          requestId: requestMetadata.requestId,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    if (!telegramBotConnectionId) {
      return NextResponse.json(
        {
          error:
            "telegramBotConnectionId is required to unbind a Telegram channel.",
        },
        {
          status: 400,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    const result = await unassignOwnerTelegramBotConnection({
      ownerId: actorId,
      actorId,
      bindingId,
      telegramBotConnectionId,
      ...requestMetadata,
    });
    return NextResponse.json(
      {
        bindingId: result.binding.id,
        representativeId: result.binding.representativeId,
        telegramBotConnectionId:
          result.binding.telegramBotConnectionId,
        changed: result.changed,
        requestId: requestMetadata.requestId,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return channelManagementErrorResponse(
      error,
      "Failed to disconnect channel.",
    );
  }
}
