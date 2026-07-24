import { PaymentProvider } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  approveWithdrawRequest,
  markWithdrawRequestFailed,
  markWithdrawRequestPaid,
  rejectWithdrawRequest,
} from "@delegate/web-data";

import { withPrivateNoStore } from "../../../../../private-response";
import {
  dashboardAuthErrorResponse,
  requireDashboardBillingAccess,
} from "../../../../auth";

const commonFields = {
  idempotencyKey: z.string().trim().min(1).max(200),
};

const mockWithdrawalActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    ...commonFields,
  }).strict(),
  z.object({
    action: z.literal("reject"),
    ...commonFields,
    reason: z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    action: z.literal("mark_paid"),
    ...commonFields,
  }).strict(),
  z.object({
    action: z.literal("mark_failed"),
    ...commonFields,
    reason: z.string().trim().min(1).max(500),
    permanent: z.boolean().optional(),
  }).strict(),
]);

export async function POST(
  request: Request,
  {
    params,
  }: { params: Promise<{ withdrawalId: string }> },
) {
  if (process.env.NODE_ENV === "production") {
    return privateJson({ error: "Not found." }, 404);
  }

  try {
    const session = await requireDashboardBillingAccess();
    const { withdrawalId: rawWithdrawalId } = await params;
    const withdrawRequestId = rawWithdrawalId.trim();
    if (!withdrawRequestId) {
      return privateJson({ error: "withdrawRequestId is required." }, 400);
    }

    const parsed = mockWithdrawalActionSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return privateJson({ error: "A valid mock withdrawal action is required." }, 400);
    }

    const actorId = `local-mock:${session.ownerId}`;
    const input = parsed.data;
    const withdrawal =
      input.action === "approve"
        ? await approveWithdrawRequest({
            ownerId: session.ownerId,
            withdrawRequestId,
            reviewedBy: actorId,
            idempotencyKey: input.idempotencyKey,
          })
        : input.action === "reject"
          ? await rejectWithdrawRequest({
              ownerId: session.ownerId,
              withdrawRequestId,
              reviewedBy: actorId,
              reason: input.reason,
              idempotencyKey: input.idempotencyKey,
            })
          : input.action === "mark_paid"
            ? await markWithdrawRequestPaid({
                ownerId: session.ownerId,
                withdrawRequestId,
                provider: PaymentProvider.MOCK,
                providerPayoutId: mockProviderPayoutId(
                  withdrawRequestId,
                  input.idempotencyKey,
                ),
                idempotencyKey: input.idempotencyKey,
              })
            : await markWithdrawRequestFailed({
                ownerId: session.ownerId,
                withdrawRequestId,
                reason: input.reason,
                permanent: input.permanent ?? false,
                idempotencyKey: input.idempotencyKey,
              });

    return privateJson({ withdrawal }, 200);
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return withPrivateNoStore(authResponse);

    console.error("Failed to apply local mock withdrawal action.", error);
    return privateJson(
      { error: "Failed to apply local mock withdrawal action." },
      400,
    );
  }
}

function mockProviderPayoutId(
  withdrawRequestId: string,
  idempotencyKey: string,
) {
  return `mock:${withdrawRequestId}:${idempotencyKey}`;
}

function privateJson(body: unknown, status: number) {
  return withPrivateNoStore(NextResponse.json(body, { status }));
}
