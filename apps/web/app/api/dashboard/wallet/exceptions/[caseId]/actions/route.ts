import { NextResponse } from "next/server";
import { z } from "zod";

import {
  actOnWalletExceptionCase,
  WalletExceptionActionError,
} from "@delegate/web-data";

import { withPrivateNoStore } from "../../../../../private-response";
import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess,
} from "../../../../auth";

const walletExceptionActionSchema = z.object({
  action: z.enum(["claim", "retry", "acknowledge"]),
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(1).max(128),
  note: z.string().trim().max(1_000).optional(),
}).strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const representativeSlug =
    new URL(request.url).searchParams.get("rep")?.trim() ?? "";
  if (!representativeSlug) {
    return privateJson(
      {
        code: "representative_required",
        error: "An active representative is required.",
      },
      400,
    );
  }

  try {
    const session =
      await requireDashboardRepresentativeBillingAccess(
        representativeSlug,
      );
    const { caseId } = await params;
    const parsed = walletExceptionActionSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!caseId.trim() || !parsed.success) {
      return privateJson(
        {
          code: "wallet_exception_action_invalid",
          error: "A valid wallet exception action is required.",
        },
        400,
      );
    }
    const exceptionCase = await actOnWalletExceptionCase({
      caseId: caseId.trim(),
      ownerId: session.ownerId,
      representativeSlug,
      action: parsed.data.action,
      expectedVersion: parsed.data.expectedVersion,
      idempotencyKey: parsed.data.idempotencyKey,
      ...(parsed.data.note !== undefined
        ? { note: parsed.data.note }
        : {}),
    });
    return privateJson({ case: exceptionCase });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return withPrivateNoStore(authResponse);
    if (error instanceof WalletExceptionActionError) {
      return privateJson(
        { code: error.code, error: error.message },
        error.statusCode,
      );
    }
    console.error("Failed to apply wallet exception action.", {
      code: "wallet_exception_action_failed",
    });
    return privateJson(
      {
        code: "wallet_exception_action_failed",
        error: "The wallet exception action could not be applied.",
      },
      500,
    );
  }
}

function privateJson(body: unknown, status = 200) {
  return withPrivateNoStore(
    NextResponse.json(body, { status }),
  );
}
