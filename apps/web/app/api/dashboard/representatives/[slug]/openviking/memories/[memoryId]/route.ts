import { NextResponse } from "next/server";
import { z } from "zod";

import {
  deleteRepresentativeOpenVikingMemory,
  retryRepresentativeOpenVikingMemoryDeletion,
  suppressRepresentativeOpenVikingMemory,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../../auth";
import { withPrivateNoStore } from "../../../../../../private-response";
import { toDashboardGovernedMemoryDto } from "../../safe-dto";

const memoryActionSchema = z.object({
  action: z.enum(["suppress", "retry"]),
}).strict();

type RouteContext = {
  params: Promise<{ slug: string; memoryId: string }>;
};

export async function PATCH(request: Request, context: RouteContext) {
  const { slug, memoryId } = await context.params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const body = await request.json().catch(() => null);
    const parsed = memoryActionSchema.safeParse(body);
    if (!parsed.success) {
      return withPrivateNoStore(
        NextResponse.json(
          { error: "Unsupported governed memory action." },
          { status: 422 },
        ),
      );
    }
    const memory =
      parsed.data.action === "suppress"
        ? await suppressRepresentativeOpenVikingMemory({
            representativeSlug: slug,
            memoryId,
            ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
          })
        : await retryRepresentativeOpenVikingMemoryDeletion({
            representativeSlug: slug,
            memoryId,
            ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
          });
    if (!memory) {
      return withPrivateNoStore(
        NextResponse.json({ error: "Memory record not found." }, { status: 404 }),
      );
    }

    return withPrivateNoStore(
      NextResponse.json({
        memory: toDashboardGovernedMemoryDto(memory),
      }),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }
    return withPrivateNoStore(
      NextResponse.json(
        { error: "Failed to update governed memory state." },
        { status: 500 },
      ),
    );
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { slug, memoryId } = await context.params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const memory = await deleteRepresentativeOpenVikingMemory({
      representativeSlug: slug,
      memoryId,
      ...(session?.ownerId ? { ownerId: session.ownerId } : {}),
    });
    if (!memory) {
      return withPrivateNoStore(
        NextResponse.json({ error: "Memory record not found." }, { status: 404 }),
      );
    }

    return withPrivateNoStore(
      NextResponse.json({
        memory: toDashboardGovernedMemoryDto(memory),
      }),
    );
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return withPrivateNoStore(authResponse);
    }
    return withPrivateNoStore(
      NextResponse.json(
        { error: "Failed to delete governed memory." },
        { status: 500 },
      ),
    );
  }
}
