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
      expectedCurrentEndpointAssignmentRevision?: unknown;
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
    if (
      typeof body.expectedCurrentEndpointAssignmentRevision !== "number"
      || !Number.isSafeInteger(
        body.expectedCurrentEndpointAssignmentRevision,
      )
      || body.expectedCurrentEndpointAssignmentRevision <= 0
    ) {
      return NextResponse.json(
        {
          error:
            "expectedCurrentEndpointAssignmentRevision must be a positive integer.",
        },
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
      expectedCurrentEndpointAssignmentRevision:
        body.expectedCurrentEndpointAssignmentRevision,
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
    const expectedCurrentEndpointAssignmentRevision =
      parsePositiveInteger(
        searchParams.get("expectedEndpointAssignmentRevision"),
      );
    if (expectedCurrentEndpointAssignmentRevision === null) {
      return NextResponse.json(
        {
          error:
            "expectedEndpointAssignmentRevision must be a positive integer.",
        },
        {
          status: 400,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    const actorId = session?.ownerId ?? "local-owner";
    const requestMetadata = resolveChannelRequestMetadata(request);
    if (channel === "MATRIX") {
      const result = await disconnectOwnerMatrixChannel({
        ownerId: actorId,
        actorId,
        bindingId,
        expectedCurrentEndpointAssignmentRevision,
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
      expectedCurrentEndpointAssignmentRevision,
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

function parsePositiveInteger(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
