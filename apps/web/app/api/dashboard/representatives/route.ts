import { NextResponse } from "next/server";
import { ZodError } from "zod";

import {
  createRepresentative,
  listRepresentativeDirectoryItems,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardApiOwnerSession,
} from "../auth";
import { normalizeRepresentativeCreateBody } from "./create-validation";

export async function GET() {
  try {
    const session = await requireDashboardApiOwnerSession();
    const representatives = await listRepresentativeDirectoryItems(session?.ownerId);
    return NextResponse.json({ representatives });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load representatives.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireDashboardApiOwnerSession();
    const body = (await request.json()) as Record<string, unknown>;
    const normalized = normalizeRepresentativeCreateBody(body);
    if (!normalized.ok) {
      return NextResponse.json(
        {
          error: normalized.error,
          fieldErrors: normalized.fieldErrors,
        },
        { status: 400 },
      );
    }

    const created = await createRepresentative(
      normalized.input,
      session?.ownerId ? { ownerId: session.ownerId } : {},
    );

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "请检查代表信息后再提交。" },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create representative.",
      },
      { status: 400 },
    );
  }
}
