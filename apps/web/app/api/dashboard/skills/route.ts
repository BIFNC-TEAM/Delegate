import { NextResponse } from "next/server";

import {
  assertOwnerCanManageSkills,
  getWorkspaceSkillSnapshot,
  installClawHubSkillForWorkspace,
  recordWorkspaceCapabilityOperationFailure,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../auth";
import { withPrivateNoStore } from "../../private-response";
import { workspaceSkillApiErrorResponse } from "./errors";

export async function GET(request: Request) {
  const representativeSlug = new URL(request.url).searchParams.get("rep")?.trim();
  if (!representativeSlug) {
    return withPrivateNoStore(
      NextResponse.json({ error: "rep is required." }, { status: 400 }),
    );
  }

  try {
    const session = await requireDashboardRepresentativeAccess(representativeSlug);
    const snapshot = await getWorkspaceSkillSnapshot({
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
      activeRepresentativeSlug: representativeSlug,
    });
    if (!snapshot) {
      return withPrivateNoStore(
        NextResponse.json({ error: "Workspace not found." }, { status: 404 }),
      );
    }
    return withPrivateNoStore(NextResponse.json(snapshot));
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return withPrivateNoStore(authResponse);
    return withPrivateNoStore(
      workspaceSkillApiErrorResponse(
        error,
        "Failed to load workspace skills.",
      ),
    );
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    representativeSlug?: unknown;
    skillPackSlug?: unknown;
  } | null;
  const representativeSlug = typeof body?.representativeSlug === "string"
    ? body.representativeSlug.trim()
    : "";
  const skillPackSlug = typeof body?.skillPackSlug === "string" ? body.skillPackSlug.trim() : "";
  if (!representativeSlug || !skillPackSlug) {
    return NextResponse.json(
      { error: "representativeSlug and skillPackSlug are required." },
      { status: 400 },
    );
  }

  let metricOwnerId: string | null = null;
  try {
    const session = await requireDashboardRepresentativeAccess(representativeSlug);
    metricOwnerId = session?.ownerId ?? null;
    if (session?.ownerId) await assertOwnerCanManageSkills(session.ownerId);
    const install = await installClawHubSkillForWorkspace({
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
      activeRepresentativeSlug: representativeSlug,
      skillPackSlug,
      installedBy: session?.ownerId ?? "local-owner",
    });
    return NextResponse.json({ install }, { status: 201 });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    recordWorkspaceCapabilityOperationFailure({
      ownerId: metricOwnerId,
      representativeSlug,
      operation: "skill_registry_sync",
      error,
    });
    return workspaceSkillApiErrorResponse(
      error,
      "Failed to install workspace skill.",
    );
  }
}
