import { NextResponse } from "next/server";

import {
  assignOwnerTelegramBotConnection,
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
      telegramBotConnectionId?: unknown;
      expectedCurrentTelegramBotConnectionId?: unknown;
      expectedCurrentEndpointAssignmentRevision?: unknown;
      matrixUserId?: unknown;
      replaceExisting?: unknown;
      expectedCurrentMatrixUserId?: unknown;
    } | null;
    if (
      (
        body?.channel !== "MATRIX"
        && body?.channel !== "TELEGRAM"
      )
      || typeof body.representativeId !== "string"
      || !body.representativeId.trim()
    ) {
      return NextResponse.json(
        {
          error:
            "channel must be MATRIX or TELEGRAM and representativeId is required.",
        },
        {
          status: 400,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    if (
      body.channel === "TELEGRAM"
      && (
        typeof body.telegramBotConnectionId !== "string"
        || !body.telegramBotConnectionId.trim()
      )
    ) {
      return NextResponse.json(
        {
          error:
            "telegramBotConnectionId is required when channel is TELEGRAM.",
        },
        {
          status: 400,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    if (
      body.channel === "TELEGRAM"
      && !isOptionalNonEmptyStringOrNull(
        body.expectedCurrentTelegramBotConnectionId,
      )
    ) {
      return badRequest(
        "expectedCurrentTelegramBotConnectionId must be a non-empty string or null.",
      );
    }
    if (
      !isPositiveIntegerOrNull(
        body.expectedCurrentEndpointAssignmentRevision,
      )
    ) {
      return badRequest(
        "expectedCurrentEndpointAssignmentRevision must be a positive integer or null.",
      );
    }
    if (
      body.channel === "MATRIX"
      && (
        (
          body.matrixUserId !== undefined
          && (
            typeof body.matrixUserId !== "string"
            || !body.matrixUserId.trim()
          )
        )
        || (
          body.replaceExisting !== undefined
          && typeof body.replaceExisting !== "boolean"
        )
        || !isOptionalNonEmptyStringOrNull(
          body.expectedCurrentMatrixUserId,
        )
      )
    ) {
      return badRequest(
        "matrixUserId must be a non-empty string, replaceExisting must be boolean, and expectedCurrentMatrixUserId must be a non-empty string or null.",
      );
    }
    const actorId = session?.ownerId ?? "local-owner";
    const requestMetadata = resolveChannelRequestMetadata(request);
    const provisioned =
      body.channel === "TELEGRAM"
        ? await assignOwnerTelegramBotConnection({
            ownerId: actorId,
            actorId,
            representativeId: body.representativeId,
            telegramBotConnectionId: body.telegramBotConnectionId as string,
            ...(body.expectedCurrentTelegramBotConnectionId !== undefined
              ? {
                  expectedCurrentTelegramBotConnectionId:
                    body.expectedCurrentTelegramBotConnectionId as
                      string | null,
                }
              : {}),
            expectedCurrentEndpointAssignmentRevision:
              body.expectedCurrentEndpointAssignmentRevision as
                number | null,
            ...requestMetadata,
          })
        : await provisionOwnerMatrixChannel({
            ownerId: actorId,
            actorId,
            representativeId: body.representativeId,
            ...(body.matrixUserId !== undefined
              ? { matrixUserId: (body.matrixUserId as string).trim() }
              : {}),
            ...(body.replaceExisting !== undefined
              ? { replaceExisting: body.replaceExisting as boolean }
              : {}),
            ...(body.expectedCurrentMatrixUserId !== undefined
              ? {
                  expectedCurrentMatrixUserId:
                    body.expectedCurrentMatrixUserId as string | null,
                }
              : {}),
            expectedCurrentEndpointAssignmentRevision:
              body.expectedCurrentEndpointAssignmentRevision as
                number | null,
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
      "Failed to provision channel.",
    );
  }
}

function isOptionalNonEmptyStringOrNull(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === "string" && Boolean(value.trim()));
}

function isPositiveIntegerOrNull(value: unknown): boolean {
  return value === null
    || (
      typeof value === "number"
      && Number.isSafeInteger(value)
      && value > 0
    );
}

function badRequest(error: string) {
  return NextResponse.json(
    { error },
    {
      status: 400,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
