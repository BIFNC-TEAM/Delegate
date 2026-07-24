import {
  assertOwnerCanAccessRepresentative,
  createWithdrawRequest,
} from "@delegate/web-data";

import {
  dashboardAuthErrorResponse,
  requireDashboardRepresentativeBillingAccess,
} from "../../auth";
import {
  privateWalletJson,
  walletWithdrawalErrorResponse,
} from "../withdrawal-response";

export async function POST(request: Request) {
  const activeRepresentativeSlug =
    new URL(request.url).searchParams.get("rep")?.trim() ?? "";
  if (!activeRepresentativeSlug) {
    return privateWalletJson({ error: "rep is required." }, { status: 400 });
  }

  try {
    const session = await requireDashboardRepresentativeBillingAccess(
      activeRepresentativeSlug,
    );
    const bodyValue: unknown = await request.json().catch(() => null);
    if (!bodyValue || typeof bodyValue !== "object" || Array.isArray(bodyValue)) {
      return privateWalletJson(
        { error: "A valid JSON request body is required." },
        { status: 400 },
      );
    }
    const body = bodyValue as Record<string, unknown>;
    const representativeSlug = requiredText(
      body.representativeSlug,
      "representativeSlug",
    );
    const currency = requiredText(body.currency, "currency").toUpperCase();
    const idempotencyKey = requiredText(
      body.idempotencyKey,
      "idempotencyKey",
    );
    const amountCents = body.amountCents;
    if (
      !Number.isInteger(amountCents)
      || (amountCents as number) <= 0
    ) {
      return privateWalletJson(
        { error: "amountCents must be a positive integer." },
        { status: 400 },
      );
    }
    if (currency !== "CNY" && currency !== "USD") {
      return privateWalletJson(
        { error: "Unsupported withdrawal currency." },
        { status: 400 },
      );
    }
    if (idempotencyKey.length > 200) {
      return privateWalletJson(
        { error: "idempotencyKey is too long." },
        { status: 400 },
      );
    }

    const representative = await assertOwnerCanAccessRepresentative({
      ownerId: session.ownerId,
      representativeSlug,
    });
    const withdrawal = await createWithdrawRequest({
      ownerId: session.ownerId,
      representativeId: representative.id,
      amountCents: amountCents as number,
      currency,
      idempotencyKey,
    });
    return privateWalletJson({ withdrawal }, { status: 201 });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof WalletMutationInputError) {
      return privateWalletJson({ error: error.message }, { status: 400 });
    }
    return walletWithdrawalErrorResponse(error);
  }
}

class WalletMutationInputError extends Error {}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WalletMutationInputError(`${field} is required.`);
  }
  return value.trim();
}
