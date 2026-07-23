import { NextResponse } from "next/server";

import {
  assertOwnerCanManageSkills,
  updateRepresentativeManagedPolicyOverlays,
} from "@delegate/web-data";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess,
} from "../../../../auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const session = await requireDashboardRepresentativeAccess(slug);
    if (session?.ownerId) await assertOwnerCanManageSkills(session.ownerId);
    const body = (await request.json()) as Record<string, unknown>;
    const overlays = await updateRepresentativeManagedPolicyOverlays({
      representativeSlug: slug,
      overlays: {
        baseline: {
          enabled: body.baseline && typeof body.baseline === "object" && "enabled" in body.baseline
            ? (body.baseline as { enabled?: boolean }).enabled !== false
            : true,
          browserDecision:
            body.baseline &&
            typeof body.baseline === "object" &&
            ((body.baseline as { browserDecision?: string }).browserDecision === "allow" ||
              (body.baseline as { browserDecision?: string }).browserDecision === "deny")
              ? ((body.baseline as { browserDecision: "allow" | "deny" }).browserDecision)
              : "ask",
          browserRequiresApproval:
            body.baseline &&
            typeof body.baseline === "object" &&
            "browserRequiresApproval" in body.baseline
              ? (body.baseline as { browserRequiresApproval?: boolean }).browserRequiresApproval !==
                false
              : true,
          mcpDecision:
            body.baseline &&
            typeof body.baseline === "object" &&
            ((body.baseline as { mcpDecision?: string }).mcpDecision === "allow" ||
              (body.baseline as { mcpDecision?: string }).mcpDecision === "deny")
              ? ((body.baseline as { mcpDecision: "allow" | "deny" }).mcpDecision)
              : "ask",
          mcpRequiresApproval:
            body.baseline &&
            typeof body.baseline === "object" &&
            "mcpRequiresApproval" in body.baseline
              ? (body.baseline as { mcpRequiresApproval?: boolean }).mcpRequiresApproval !== false
              : true,
          requiredPlanTier:
            body.baseline &&
            typeof body.baseline === "object" &&
            (body.baseline as { requiredPlanTier?: string }).requiredPlanTier === "deep_help"
              ? "deep_help"
              : "pass",
        },
        trustedCustomer: {
          enabled:
            body.trustedCustomer &&
            typeof body.trustedCustomer === "object" &&
            "enabled" in body.trustedCustomer
              ? (body.trustedCustomer as { enabled?: boolean }).enabled !== false
              : true,
          trustTier:
            body.trustedCustomer &&
            typeof body.trustedCustomer === "object" &&
            ((body.trustedCustomer as { trustTier?: string }).trustTier === "verified" ||
              (body.trustedCustomer as { trustTier?: string }).trustTier === "vip" ||
              (body.trustedCustomer as { trustTier?: string }).trustTier === "restricted")
              ? ((body.trustedCustomer as {
                  trustTier: "verified" | "vip" | "restricted";
                }).trustTier)
              : "standard",
          browserDecision:
            body.trustedCustomer &&
            typeof body.trustedCustomer === "object" &&
            ((body.trustedCustomer as { browserDecision?: string }).browserDecision === "allow" ||
              (body.trustedCustomer as { browserDecision?: string }).browserDecision === "deny")
              ? ((body.trustedCustomer as { browserDecision: "allow" | "deny" }).browserDecision)
              : "ask",
          browserRequiresApproval:
            body.trustedCustomer &&
            typeof body.trustedCustomer === "object" &&
            "browserRequiresApproval" in body.trustedCustomer
              ? (body.trustedCustomer as { browserRequiresApproval?: boolean })
                  .browserRequiresApproval !== false
              : true,
          mcpDecision:
            body.trustedCustomer &&
            typeof body.trustedCustomer === "object" &&
            ((body.trustedCustomer as { mcpDecision?: string }).mcpDecision === "allow" ||
              (body.trustedCustomer as { mcpDecision?: string }).mcpDecision === "deny")
              ? ((body.trustedCustomer as { mcpDecision: "allow" | "deny" }).mcpDecision)
              : "ask",
          mcpRequiresApproval:
            body.trustedCustomer &&
            typeof body.trustedCustomer === "object" &&
            "mcpRequiresApproval" in body.trustedCustomer
              ? (body.trustedCustomer as { mcpRequiresApproval?: boolean })
                  .mcpRequiresApproval !== false
              : true,
          requiredPlanTier:
            body.trustedCustomer &&
            typeof body.trustedCustomer === "object" &&
            (body.trustedCustomer as { requiredPlanTier?: string }).requiredPlanTier ===
              "deep_help"
              ? "deep_help"
              : "pass",
        },
      },
    });

    return NextResponse.json({ overlays });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) {
      return authResponse;
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update managed policy overlays.",
      },
      { status: 400 },
    );
  }
}
