import { NextResponse } from "next/server";
import { z } from "zod";

import {
  applyRepresentativeDelegationExternalEffectAction,
  DelegationTaskActionError,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../../../auth";

const externalEffectActionSchema = z.object({
  action: z.enum(["reconcile", "retry", "record_compensation"]),
  observedOutcome: z.enum(["succeeded", "failed"]).optional(),
  externalReferenceId: z.string().trim().max(500).optional(),
  note: z.string().trim().max(1_000).optional(),
}).strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; taskId: string; effectId: string }> },
) {
  const { slug, taskId, effectId } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const parsedBody = externalEffectActionSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsedBody.success) {
      return NextResponse.json({ error: "Invalid external effect action." }, { status: 400 });
    }
    const body = parsedBody.data;
    if (body.action === "reconcile" && !["succeeded", "failed"].includes(body.observedOutcome || "")) {
      return NextResponse.json({ error: "Reconciliation requires succeeded or failed outcome." }, { status: 400 });
    }
    const detail = await applyRepresentativeDelegationExternalEffectAction({
      representativeSlug: slug,
      taskId,
      effectId,
      action: body.action,
      actorId: session?.ownerId || "local-owner",
      ...(body.observedOutcome ? { observedOutcome: body.observedOutcome } : {}),
      ...(body.externalReferenceId?.trim() ? { externalReferenceId: body.externalReferenceId.trim() } : {}),
      ...(body.note?.trim() ? { note: body.note.trim() } : {}),
    });
    return NextResponse.json(detail);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof DelegationTaskActionError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    return NextResponse.json(
      { error: "Failed to update external effect." },
      { status: 500 },
    );
  }
}
