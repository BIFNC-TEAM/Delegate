import { NextResponse } from "next/server";

import {
  applyRepresentativeDelegationExternalEffectAction,
  DelegationTaskActionError,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../../../auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; taskId: string; effectId: string }> },
) {
  const { slug, taskId, effectId } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    const body = (await request.json()) as {
      action?: "reconcile" | "retry" | "record_compensation";
      observedOutcome?: "succeeded" | "failed";
      externalReferenceId?: string;
      note?: string;
    };
    if (!body.action || !["reconcile", "retry", "record_compensation"].includes(body.action)) {
      return NextResponse.json({ error: "Invalid external effect action." }, { status: 400 });
    }
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
      { error: error instanceof Error ? error.message : "Failed to update external effect." },
      { status: 500 },
    );
  }
}
