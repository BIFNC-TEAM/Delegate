import { NextResponse } from "next/server";

import {
  revokeOwnerTelegramBotConnection,
  rotateOwnerTelegramBotConnection,
  setOwnerTelegramBotConnectionStatus,
  type OwnerTelegramBotConnection,
} from "@delegate/web-data";

import { requireDashboardApiOwnerSession } from "../../../auth";
import { channelManagementErrorResponse } from "../../errors";
import { resolveChannelRequestMetadata } from "../../request-metadata";

const maxConnectionIdLength = 191;
const maxTokenLength = 512;
const maxLabelLength = 100;

type RouteContext = {
  params: Promise<{ connectionId: string }>;
};

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const connectionId = normalizeConnectionId((await params).connectionId);
    if (!connectionId) {
      return privateJson(
        { error: "A valid Telegram Bot connection id is required." },
        400,
      );
    }

    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      token?: unknown;
      label?: unknown;
    } | null;
    if (
      body?.action !== "rotate"
      && body?.action !== "disable"
      && body?.action !== "resume"
    ) {
      return privateJson(
        { error: "action must be rotate, disable, or resume." },
        400,
      );
    }

    const actorId = session?.ownerId ?? "local-owner";
    const requestMetadata = resolveChannelRequestMetadata(request);
    if (body.action === "rotate") {
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token || token.length > maxTokenLength) {
        return privateJson(
          { error: "A valid Telegram Bot token is required." },
          400,
        );
      }
      const label = normalizeLabel(body.label);
      if (label === undefined && body.label !== undefined) {
        return privateJson(
          { error: `label must be at most ${maxLabelLength} characters.` },
          400,
        );
      }
      const result = await rotateOwnerTelegramBotConnection({
        ownerId: actorId,
        actorId,
        telegramBotConnectionId: connectionId,
        token,
        ...(label === undefined ? {} : { label }),
        ...requestMetadata,
      });
      return privateJson({
        connection: serializeOwnerTelegramBotConnection(result.connection),
        action: "rotate",
        changed: result.changed,
        requestId: requestMetadata.requestId,
      });
    }

    const result = await setOwnerTelegramBotConnectionStatus({
      ownerId: actorId,
      actorId,
      telegramBotConnectionId: connectionId,
      status: body.action === "disable" ? "DISABLED" : "ACTIVE",
      ...requestMetadata,
    });
    return privateJson({
      connection: serializeOwnerTelegramBotConnection(result.connection),
      action: body.action,
      changed: result.changed,
      requestId: requestMetadata.requestId,
    });
  } catch (error) {
    return channelManagementErrorResponse(
      error,
      "Failed to update Telegram Bot connection.",
    );
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const connectionId = normalizeConnectionId((await params).connectionId);
    if (!connectionId) {
      return privateJson(
        { error: "A valid Telegram Bot connection id is required." },
        400,
      );
    }
    const actorId = session?.ownerId ?? "local-owner";
    const requestMetadata = resolveChannelRequestMetadata(request);
    const result = await revokeOwnerTelegramBotConnection({
      ownerId: actorId,
      actorId,
      telegramBotConnectionId: connectionId,
      ...requestMetadata,
    });
    return privateJson({
      connection: serializeOwnerTelegramBotConnection(result.connection),
      action: "revoke",
      changed: result.changed,
      requestId: requestMetadata.requestId,
    });
  } catch (error) {
    return channelManagementErrorResponse(
      error,
      "Failed to revoke Telegram Bot connection.",
    );
  }
}

function normalizeConnectionId(value: string) {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maxConnectionIdLength
    || normalized.includes("\0")
  ) {
    return null;
  }
  return normalized;
}

function normalizeLabel(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length > maxLabelLength || normalized.includes("\0")) {
    return undefined;
  }
  return normalized || null;
}

function serializeOwnerTelegramBotConnection(
  connection: OwnerTelegramBotConnection,
) {
  return {
    id: connection.id,
    botId: connection.botId,
    username: connection.username,
    displayName: connection.displayName,
    label: connection.label,
    status: connection.status,
    healthStatus: connection.healthStatus,
    verificationStatus: connection.verificationStatus,
    lastVerifiedAt: connection.lastVerifiedAt,
    lastHealthCheckAt: connection.lastHealthCheckAt,
    lastError: connection.lastError,
    credentialRevision: connection.credentialRevision,
    referenceCount: connection.referenceCount,
    activeReferenceCount: connection.activeReferenceCount,
  };
}

function privateJson(
  body: Record<string, unknown>,
  status = 200,
) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
