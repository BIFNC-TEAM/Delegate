import { NextResponse } from "next/server";

import {
  createCreatorTrainingSource,
  listCreatorTrainingSources,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
  requireDashboardRepresentativeAccessActor,
} from "../../../../auth";
import { withPrivateNoStore } from "../../../../../private-response";
import { creatorTrainingApiErrorResponse } from "../errors";
import { toDashboardDevelopmentSourceDto } from "../safe-dto";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  try {
    const sources = await listCreatorTrainingSources(slug);
    return withPrivateNoStore(
      NextResponse.json({
        sources: sources.map(toDashboardDevelopmentSourceDto),
      }),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to load development sources.",
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const actor = await requireDashboardRepresentativeAccessActor(slug);
    const body = (await request.json()) as Record<string, unknown>;
    const source = await createCreatorTrainingSource(slug, {
      kind: String(body.kind ?? ""),
      title: String(body.title ?? ""),
      ...(typeof body.locator === "string" ? { locator: body.locator } : {}),
      ...(typeof body.contentText === "string" ? { contentText: body.contentText } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      createdBy: actor,
    });

    return withPrivateNoStore(
      NextResponse.json(
        { source: toDashboardDevelopmentSourceDto(source) },
        { status: 201 },
      ),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to create the development source.",
    );
  }
}
