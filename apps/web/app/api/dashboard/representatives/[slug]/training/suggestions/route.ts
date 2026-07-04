import { NextResponse } from "next/server";

import {
  buildCreatorTrainingSuggestions,
  listCreatorTrainingSuggestions,
  type CreatorTrainingSuggestionStatus,
} from "@delegate/web-data";

const suggestionStatuses = new Set([
  "pending",
  "approved",
  "rejected",
  "private",
  "published",
]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const limitValue = Number(url.searchParams.get("limit") ?? 50);
    const suggestions = await listCreatorTrainingSuggestions(slug, {
      ...(status && suggestionStatuses.has(status)
        ? { status: status as CreatorTrainingSuggestionStatus }
        : {}),
      limit: Number.isFinite(limitValue) ? limitValue : 50,
    });

    return NextResponse.json({ suggestions });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load creator training suggestions.",
      },
      { status: 400 },
    );
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const suggestions = await buildCreatorTrainingSuggestions(slug);
    return NextResponse.json({ suggestions }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to build creator training suggestions.",
      },
      { status: 400 },
    );
  }
}
