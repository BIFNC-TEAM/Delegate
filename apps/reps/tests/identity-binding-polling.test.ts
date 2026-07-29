import { describe, expect, it } from "vitest";

import {
  bindingPollRetryDelayMs,
  isInstructionBindingCurrent,
} from "../app/reps/[slug]/identity-binding-polling";

const currentBindings = {
  telegram: [
    {
      provider: "TELEGRAM" as const,
      providerSubject: "101",
      issuer: "delegate-managed-bot",
      connectionId: "8718299151",
    },
  ],
  matrix: [
    {
      provider: "MATRIX" as const,
      providerSubject: "@alice:example.org",
      issuer: "example.org",
      connectionId: "delegate-matrix-as",
    },
  ],
};

describe("identity binding polling decisions", () => {
  it("accepts only the consumed Matrix subject on the current endpoint", () => {
    expect(
      isInstructionBindingCurrent(currentBindings, {
        provider: "matrix",
        expectedProviderSubject: "@alice:example.org",
        consumedProviderSubject: "@alice:example.org",
        scope: {
          issuer: "example.org",
          connectionId: "delegate-matrix-as",
        },
      }),
    ).toBe(true);
    expect(
      isInstructionBindingCurrent(currentBindings, {
        provider: "matrix",
        expectedProviderSubject: "@bob:example.org",
        consumedProviderSubject: "@bob:example.org",
        scope: {
          issuer: "example.org",
          connectionId: "delegate-matrix-as",
        },
      }),
    ).toBe(false);
  });

  it("rejects a consumed command after the representative endpoint changes", () => {
    expect(
      isInstructionBindingCurrent(currentBindings, {
        provider: "telegram",
        consumedProviderSubject: "101",
        scope: {
          issuer: "delegate-managed-bot",
          connectionId: "9999999999",
        },
      }),
    ).toBe(false);
  });

  it("does not mistake another Telegram account on the same Bot for the consumer", () => {
    expect(
      isInstructionBindingCurrent(currentBindings, {
        provider: "telegram",
        consumedProviderSubject: "202",
        scope: {
          issuer: "delegate-managed-bot",
          connectionId: "8718299151",
        },
      }),
    ).toBe(false);
  });

  it("rejects a Matrix success without its account-bound subject", () => {
    expect(
      isInstructionBindingCurrent(currentBindings, {
        provider: "matrix",
        consumedProviderSubject: "@alice:example.org",
        scope: {
          issuer: "example.org",
          connectionId: "delegate-matrix-as",
        },
      }),
    ).toBe(false);
  });

  it("backs off transient failures and eventually pauses", () => {
    expect(
      [1, 2, 3, 4, 5].map(bindingPollRetryDelayMs),
    ).toEqual([2_000, 4_000, 8_000, 16_000, null]);
  });
});
