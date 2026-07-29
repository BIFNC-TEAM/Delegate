import { NextResponse } from "next/server";

import { RepresentativeAccessError } from "@delegate/web-data";
import {
  OwnerSettingsError,
  getOwnerSettingsSnapshot,
  updateOwnerNotificationSettings,
  updateOwnerProfileSettings,
} from "@delegate/web-data/owner-settings";
import { localeCookieName } from "@delegate/web-ui";

import { withPrivateNoStore } from "../../private-response";
import { requireDashboardApiOwnerSession } from "../auth";
import { resolveDashboardRequestMetadata } from "../request-metadata";
import { ownerSettingsErrorResponse } from "./errors";

export async function GET() {
  try {
    const ownerId = await requireSettingsOwnerId();
    const snapshot = await getOwnerSettingsSnapshot({ ownerId });
    if (!snapshot.persistenceAvailable) {
      throw new OwnerSettingsError(
        "owner_settings_persistence_unavailable",
        "Settings persistence is unavailable.",
        503,
      );
    }
    return withPrivateNoStore(NextResponse.json(snapshot));
  } catch (error) {
    return ownerSettingsErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const ownerId = await requireSettingsOwnerId();
    const body = await request.json().catch(() => null) as {
      section?: unknown;
      profile?: unknown;
      notifications?: unknown;
    } | null;
    const requestMetadata = resolveDashboardRequestMetadata(request);
    let snapshot;
    if (body?.section === "profile") {
      if (!hasOnlyKeys(body, ["section", "profile"])) {
        throw invalidRequest();
      }
      snapshot = await updateOwnerProfileSettings({
        ownerId,
        profile: body.profile,
        ...requestMetadata,
      });
    } else if (body?.section === "notifications") {
      if (!hasOnlyKeys(body, ["section", "notifications"])) {
        throw invalidRequest();
      }
      snapshot = await updateOwnerNotificationSettings({
        ownerId,
        notifications: body.notifications,
        ...requestMetadata,
      });
    } else {
      throw invalidRequest();
    }

    const response = withPrivateNoStore(NextResponse.json({
      ...snapshot,
      requestId: requestMetadata.requestId,
    }));
    if (
      body.section === "profile"
      && snapshot.profile?.preferredLocale
    ) {
      response.cookies.set(
        localeCookieName,
        snapshot.profile.preferredLocale,
        {
          path: "/",
          sameSite: "lax",
          maxAge: 60 * 60 * 24 * 365,
        },
      );
    }
    return response;
  } catch (error) {
    return ownerSettingsErrorResponse(error);
  }
}

async function requireSettingsOwnerId() {
  const session = await requireDashboardApiOwnerSession();
  const ownerId = session?.ownerId?.trim();
  if (ownerId) return ownerId;
  throw new RepresentativeAccessError("Authentication required.", 401);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function invalidRequest() {
  return new OwnerSettingsError(
    "owner_settings_invalid",
    "A valid settings section is required.",
    400,
  );
}
