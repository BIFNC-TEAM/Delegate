import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PUBLIC_WALLET_UPDATED_EVENT,
  publishPublicWalletUpdate,
  type PublicWalletUpdatedDetail,
} from "../app/reps/[slug]/public-wallet-client";

describe("public wallet client updates", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes the representative-scoped authoritative credit balance", () => {
    const eventTarget = new EventTarget();
    vi.stubGlobal("window", eventTarget);
    let received: PublicWalletUpdatedDetail | null = null;
    eventTarget.addEventListener(PUBLIC_WALLET_UPDATED_EVENT, (event) => {
      received = (event as CustomEvent<PublicWalletUpdatedDetail>).detail;
    });

    publishPublicWalletUpdate({
      representativeSlug: "delegate",
      serviceCreditsAvailable: 18,
      serviceCreditsReserved: 2,
    });

    expect(received).toEqual({
      representativeSlug: "delegate",
      serviceCreditsAvailable: 18,
      serviceCreditsReserved: 2,
    });
  });
});
