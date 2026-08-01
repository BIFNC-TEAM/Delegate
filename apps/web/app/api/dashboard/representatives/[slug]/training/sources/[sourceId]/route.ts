import { NextResponse } from "next/server";

import {
  disableCreatorTrainingSource,
  updateCreatorTrainingSource,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  authorizeDashboardRepresentativeAccess,
} from "../../../../../auth";
import { withPrivateNoStore } from "../../../../../../private-response";
import { creatorTrainingApiErrorResponse } from "../../errors";
import { toDashboardDevelopmentSourceDto } from "../../safe-dto";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; sourceId: string }> },
) {
  const { slug, sourceId } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const source = await updateCreatorTrainingSource(slug, sourceId, {
      ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
      ...(typeof body.status === "string" ? { status: body.status } : {}),
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(body.locator === null || typeof body.locator === "string"
        ? { locator: body.locator }
        : {}),
      ...(body.contentText === null || typeof body.contentText === "string"
        ? { contentText: body.contentText }
        : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      ...(body.errorReason === null || typeof body.errorReason === "string"
        ? { errorReason: body.errorReason }
        : {}),
    });

    return withPrivateNoStore(
      NextResponse.json({
        source: toDashboardDevelopmentSourceDto(source),
      }),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to update the development source.",
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string; sourceId: string }> },
) {
  const { slug, sourceId } = await params;
  const accessResponse = await authorizeDashboardRepresentativeAccess(slug);
  if (accessResponse) {
    return withPrivateNoStore(accessResponse);
  }

  try {
    const source = await disableCreatorTrainingSource(slug, sourceId);
    return withPrivateNoStore(
      NextResponse.json({
        source: toDashboardDevelopmentSourceDto(source),
      }),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return creatorTrainingApiErrorResponse(
      error,
      "Failed to disable the development source.",
    );
  }
}
