import { cancelWithdrawRequest } from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess,
} from "../../../../auth";
import {
  privateWalletJson,
  walletWithdrawalErrorResponse,
} from "../../../withdrawal-response";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ withdrawalId: string }> },
) {
  const activeRepresentativeSlug =
    new URL(request.url).searchParams.get("rep")?.trim() ?? "";
  if (!activeRepresentativeSlug) {
    return privateWalletJson({ error: "rep is required." }, { status: 400 });
  }

  try {
    const session = await requireDashboardRepresentativeBillingAccess(
      activeRepresentativeSlug,
    );
    const { withdrawalId } = await params;
    if (!withdrawalId.trim()) {
      return privateWalletJson(
        { error: "withdrawalId is required." },
        { status: 400 },
      );
    }
    const bodyValue: unknown = await request.json().catch(() => null);
    if (!bodyValue || typeof bodyValue !== "object" || Array.isArray(bodyValue)) {
      return privateWalletJson(
        { error: "A valid JSON request body is required." },
        { status: 400 },
      );
    }
    const idempotencyKey =
      typeof (bodyValue as Record<string, unknown>).idempotencyKey === "string"
        ? String(
            (bodyValue as Record<string, unknown>).idempotencyKey,
          ).trim()
        : "";
    if (!idempotencyKey) {
      return privateWalletJson(
        { error: "idempotencyKey is required." },
        { status: 400 },
      );
    }
    if (idempotencyKey.length > 200) {
      return privateWalletJson(
        { error: "idempotencyKey is too long." },
        { status: 400 },
      );
    }

    const withdrawal = await cancelWithdrawRequest({
      ownerId: session.ownerId,
      withdrawRequestId: withdrawalId.trim(),
      reason: "Canceled by creator.",
      idempotencyKey,
    });
    return privateWalletJson({ withdrawal });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return walletWithdrawalErrorResponse(error);
  }
}
