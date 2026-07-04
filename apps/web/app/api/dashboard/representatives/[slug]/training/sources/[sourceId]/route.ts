import { NextResponse } from "next/server";

import {
  disableCreatorTrainingSource,
  updateCreatorTrainingSource,
} from "@delegate/web-data";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; sourceId: string }> },
) {
  const { slug, sourceId } = await params;

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

    return NextResponse.json({ source });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update creator training source.",
      },
      { status: 400 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string; sourceId: string }> },
) {
  const { slug, sourceId } = await params;

  try {
    const source = await disableCreatorTrainingSource(slug, sourceId);
    return NextResponse.json({ source });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to disable creator training source.",
      },
      { status: 400 },
    );
  }
}
