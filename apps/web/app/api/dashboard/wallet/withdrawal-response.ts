import { NextResponse } from "next/server";

import { WalletIdempotencyConflictError } from "@delegate/web-data";

import { withPrivateNoStore } from "../../private-response";

export function privateWalletJson(
  body: unknown,
  init?: ResponseInit,
) {
  return withPrivateNoStore(NextResponse.json(body, init));
}

export function walletWithdrawalErrorResponse(error: unknown) {
  if (error instanceof WalletIdempotencyConflictError) {
    return privateWalletJson({ error: error.message }, { status: 409 });
  }
  if (!(error instanceof Error)) {
    return privateWalletJson(
      { error: "Failed to update the withdrawal request." },
      { status: 500 },
    );
  }

  const statusByMessage = new Map<string, number>([
    ["Owner must be verified before requesting withdrawals.", 422],
    ["Representative must be claimed before withdrawals.", 422],
    ["Insufficient withdrawable creator balance.", 409],
    [
      "An active withdrawal request already exists for this representative and currency.",
      409,
    ],
    ["Withdrawal request not found.", 404],
  ]);
  const status = statusByMessage.get(error.message)
    ?? (error.message.startsWith("Illegal withdrawal transition:") ? 409 : null);
  if (status) {
    return privateWalletJson({ error: error.message }, { status });
  }

  return privateWalletJson(
    { error: "Failed to update the withdrawal request." },
    { status: 500 },
  );
}
