import { NextResponse } from "next/server";

import {
  createCreatorTrainingSource,
  listCreatorTrainingSources,
} from "@delegate/web-data";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const sources = await listCreatorTrainingSources(slug);
    return NextResponse.json({ sources });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load creator training sources.",
      },
      { status: 400 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const source = await createCreatorTrainingSource(slug, {
      kind: String(body.kind ?? ""),
      title: String(body.title ?? ""),
      ...(typeof body.locator === "string" ? { locator: body.locator } : {}),
      ...(typeof body.contentText === "string" ? { contentText: body.contentText } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      ...(typeof body.createdBy === "string" ? { createdBy: body.createdBy } : {}),
    });

    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create creator training source.",
      },
      { status: 400 },
    );
  }
}
