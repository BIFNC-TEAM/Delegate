import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getRepresentativeOpenVikingSnapshot,
  updateRepresentativeOpenVikingConfig,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../auth";
import { withPrivateNoStore } from "../../../../private-response";
import { toDashboardGovernedContextDto } from "./safe-dto";

const contextSettingsSchema = z.object({
  enabled: z.boolean(),
  autoRecall: z.boolean(),
  autoCapture: z.literal(false).optional().default(false),
  recallLimit: z.number().int().min(1).max(20),
  recallScoreThreshold: z.number().min(0).max(1),
}).strict();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    await requireDashboardRepresentativeAccess(slug);
    const snapshot = await getRepresentativeOpenVikingSnapshot(slug);
    if (!snapshot) {
      return withPrivateNoStore(
        NextResponse.json({ error: "Representative not found." }, { status: 404 }),
      );
    }

    return withPrivateNoStore(
      NextResponse.json(toDashboardGovernedContextDto(snapshot)),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return withPrivateNoStore(
      NextResponse.json(
        {
          error: "Failed to load governed context settings.",
        },
        { status: 500 },
      ),
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const body = await request.json().catch(() => null);
    const parsed = contextSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return withPrivateNoStore(
        NextResponse.json(
          {
            error: "Invalid governed context settings.",
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
          { status: 422 },
        ),
      );
    }

    const snapshot = await updateRepresentativeOpenVikingConfig({
      representativeSlug: slug,
      input: parsed.data,
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
    });

    return withPrivateNoStore(
      NextResponse.json(toDashboardGovernedContextDto(snapshot)),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }

    return withPrivateNoStore(
      NextResponse.json(
        {
          error: "Failed to update governed context settings.",
        },
        { status: 400 },
      ),
    );
  }
}
