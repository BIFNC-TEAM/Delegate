import { describe, expect, it } from "vitest";

import { readConversationGenerationRuntimeOutcome } from "../src/conversation-platform";

describe("conversation generation runtime outcome", () => {
  it("returns the safe model outcome without exposing unrelated snapshot data", () => {
    expect(readConversationGenerationRuntimeOutcome({
      runtimeOutcome: {
        version: 1,
        mode: "model",
        internalTrace: "must-not-leak",
      },
    })).toEqual({ mode: "model" });
  });

  it("returns only the allowlisted fallback reason", () => {
    expect(readConversationGenerationRuntimeOutcome({
      runtimeOutcome: {
        version: 1,
        mode: "fallback",
        fallbackStrategy: "deterministic_preview",
        modelRuntimeState: "missing_credentials",
        fallbackReason: "model_unavailable",
        rawReason: "secret upstream failure",
      },
    })).toEqual({
      mode: "fallback",
      fallbackReason: "model_unavailable",
    });
  });

  it("keeps an unknown fallback reason out of the owner DTO", () => {
    expect(readConversationGenerationRuntimeOutcome({
      runtimeOutcome: {
        version: 1,
        mode: "fallback",
        fallbackReason: "raw-provider-error",
      },
    })).toEqual({ mode: "fallback" });
  });

  it("ignores missing, malformed, and unsupported outcomes", () => {
    expect(readConversationGenerationRuntimeOutcome(null)).toBeUndefined();
    expect(readConversationGenerationRuntimeOutcome({
      runtimeOutcome: { version: 2, mode: "fallback" },
    })).toBeUndefined();
    expect(readConversationGenerationRuntimeOutcome({
      runtimeOutcome: { version: 1, mode: "unexpected" },
    })).toBeUndefined();
  });
});
