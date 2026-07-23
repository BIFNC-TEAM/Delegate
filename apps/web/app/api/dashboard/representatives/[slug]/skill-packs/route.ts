import { NextResponse } from "next/server";

import {
  assertOwnerCanManageSkills,
  getRepresentativeSkillPackSnapshot,
  installClawHubSkillPackForRepresentative,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
  requireDashboardRepresentativeAccess,
} from "../../../auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return accessResponse;
  }

  try {
    const snapshot = await getRepresentativeSkillPackSnapshot(slug);
    if (!snapshot) {
      return NextResponse.json({ error: "Representative not found." }, { status: 404 });
    }

    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load representative skill packs.",
      },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    if (session?.ownerId) await assertOwnerCanManageSkills(session.ownerId);
    const body = (await request.json().catch(() => null)) as {
      skillPackSlug?: unknown;
    } | null;
    const skillPackSlug = typeof body?.skillPackSlug === "string"
      ? body.skillPackSlug.trim()
      : "";
    if (!skillPackSlug) {
      return NextResponse.json({ error: "skillPackSlug is required." }, { status: 400 });
    }

    const skillPack = await installClawHubSkillPackForRepresentative({
      representativeSlug: slug,
      skillPackSlug,
    });

    return NextResponse.json({ skillPack });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to install representative skill pack.",
      },
      { status: 500 },
    );
  }
}
