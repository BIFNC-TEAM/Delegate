import { afterEach, describe, expect, it } from "vitest";

import {
  createPublicChatSessionState,
  deriveTierUsage,
  getPublicChatCookieName,
  readPublicChatSessionState,
  removeRejectedPublicChatOptimisticMessage,
  resolvePublicChatServiceCreditPendingTransition,
  resolvePublicChatServiceCreditNextStep,
  resolvePublicChatSubmissionRejection,
  resolvePublicChatTier,
  restoreRejectedPublicChatDraft,
  shouldUseSecurePublicChatCookie,
  writePublicChatSessionState,
} from "../app/reps/[slug]/public-chat";

const originalNodeEnv = process.env["NODE_ENV"];
const originalRepSessionSecret = process.env.REP_PUBLIC_CHAT_SESSION_SECRET;
const originalTelegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

describe("public chat audience identity cookie", () => {
  afterEach(() => {
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv("REP_PUBLIC_CHAT_SESSION_SECRET", originalRepSessionSecret);
    restoreEnv("TELEGRAM_WEBHOOK_SECRET", originalTelegramWebhookSecret);
  });

  it("stores only an anonymous audience identity, not chat transcript state", () => {
    const state = createPublicChatSessionState({
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    const cookie = writePublicChatSessionState({
      representativeSlug: "lao-jia",
      state,
    });
    const [encodedPayload] = cookie.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString("utf8"));

    expect(payload).toEqual({
      version: 2,
      representativeSlug: "lao-jia",
      audienceId: state.audienceId,
      sessionToken: state.sessionToken,
      expiresAt: "2026-07-11T12:00:00.000Z",
    });
    expect(JSON.stringify(payload)).not.toMatch(/recentTurns|messageText|freeRepliesUsed/);
  });

  it("rejects tampered cookies and creates a fresh anonymous identity", () => {
    const state = createPublicChatSessionState({
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    const cookie = writePublicChatSessionState({
      representativeSlug: "lao-jia",
      state,
    });
    const [encodedPayload, encodedSignature] = cookie.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString("utf8"));
    payload.audienceId = "aud_tampered";
    const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");

    const restored = readPublicChatSessionState({
      representativeSlug: "lao-jia",
      cookieValue: `${tamperedPayload}.${encodedSignature}`,
      now: new Date("2026-07-04T12:01:00.000Z"),
    });

    expect(restored.audienceId).not.toBe("aud_tampered");
    expect(restored.sessionToken).not.toBe(state.sessionToken);
  });

  it("scopes the cookie name per representative slug", () => {
    expect(getPublicChatCookieName("lao-jia")).toBe("delegate-public-chat-lao-jia");
  });

  it("uses the representative session secret in production", () => {
    restoreEnv("NODE_ENV", "production");
    restoreEnv("REP_PUBLIC_CHAT_SESSION_SECRET", "rep-secret-for-tests");
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const state = createPublicChatSessionState({
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    const cookie = writePublicChatSessionState({
      representativeSlug: "lao-jia",
      state,
    });

    const restored = readPublicChatSessionState({
      representativeSlug: "lao-jia",
      cookieValue: cookie,
      now: new Date("2026-07-04T12:01:00.000Z"),
    });

    expect(restored.audienceId).toBe(state.audienceId);
    expect(restored.sessionToken).toBe(state.sessionToken);
  });

  it("derives Secure only from the trusted canonical origin", () => {
    expect(
      shouldUseSecurePublicChatCookie(
        new Request("http://0.0.0.0:3002/reps/lao-jia", {
          headers: {
            host: "0.0.0.0:3002",
            "x-forwarded-host": "delegate.example",
          },
        }),
        {
          NODE_ENV: "production",
          NEXT_PUBLIC_REPRESENTATIVE_URL: "http://localhost:3002",
        },
      ),
    ).toBe(false);
    expect(
      shouldUseSecurePublicChatCookie(
        new Request("http://127.0.0.1:3002/reps/lao-jia", {
          headers: {
            host: "delegate.example",
            "x-forwarded-host": "localhost:3002",
          },
        }),
        {
          NODE_ENV: "production",
          NEXT_PUBLIC_REPRESENTATIVE_URL: "https://delegate.example",
        },
      ),
    ).toBe(true);
    expect(
      shouldUseSecurePublicChatCookie(
        new Request("http://localhost:3002/reps/lao-jia", {
          headers: { "x-forwarded-host": "localhost:3002" },
        }),
        {
          NODE_ENV: "production",
          NEXT_PUBLIC_REPRESENTATIVE_URL: "http://delegate.example",
        },
      ),
    ).toBe(true);
  });

  it("fails closed when the production canonical origin is missing", () => {
    expect(() =>
      shouldUseSecurePublicChatCookie(
        new Request("http://localhost:3002/reps/lao-jia"),
        { NODE_ENV: "production" },
      ),
    ).toThrow("NEXT_PUBLIC_REPRESENTATIVE_URL is required in production.");
  });

  it("unlocks paid continuation only from representative-scoped service credits", () => {
    const free = deriveTierUsage({
      freeRepliesUsed: 3,
      freeReplyLimit: 3,
    });
    const paid = deriveTierUsage({
      freeRepliesUsed: 3,
      freeReplyLimit: 3,
      serviceCreditsAvailable: 4,
      serviceCreditsReserved: 1,
      serviceCreditsPurchased: 12,
    });

    expect(free).toMatchObject({
      freeRepliesRemaining: 0,
      serviceCreditsAvailable: 0,
      serviceCreditsReserved: 0,
      passUnlocked: false,
    });
    expect(resolvePublicChatTier(free)).toBe("free");
    expect(paid).toMatchObject({
      freeRepliesRemaining: 0,
      serviceCreditsAvailable: 4,
      serviceCreditsReserved: 1,
      serviceCreditsPurchased: 12,
      passUnlocked: true,
    });
    expect(resolvePublicChatTier(paid)).toBe("pass");
  });

  it("distinguishes a service-credit rejection from a technical send failure", () => {
    expect(resolvePublicChatSubmissionRejection({
      status: 402,
      code: "service_credit_required",
    })).toBe("service_credit_required");
    expect(resolvePublicChatSubmissionRejection({
      status: 409,
      code: "memory_disclosure_stale",
    })).toBe("memory_disclosure_stale");
    expect(resolvePublicChatSubmissionRejection({
      status: 402,
      code: "unexpected",
    })).toBe("failed");
    expect(resolvePublicChatSubmissionRejection({
      status: 500,
    })).toBe("failed");
  });

  it("recovers a rejected submission without overwriting a newer draft", () => {
    const messages = [
      { id: "before", text: "already sent" },
      { id: "rejected", text: "not accepted" },
      { id: "after", text: "another message" },
    ];

    expect(removeRejectedPublicChatOptimisticMessage(
      messages,
      "rejected",
    )).toEqual([
      { id: "before", text: "already sent" },
      { id: "after", text: "another message" },
    ]);
    expect(restoreRejectedPublicChatDraft({
      currentDraft: "",
      submittedText: "not accepted",
    })).toBe("not accepted");
    expect(restoreRejectedPublicChatDraft({
      currentDraft: "newer draft",
      submittedText: "not accepted",
    })).toBe("newer draft");
  });

  it("offers only the service-credit recovery action that is actually available", () => {
    expect(resolvePublicChatServiceCreditNextStep({
      serviceCreditsAvailable: 0,
      serviceCreditsReserved: 1,
      purchaseEnabled: true,
      humanInLoop: true,
    })).toBe("pending");
    expect(resolvePublicChatServiceCreditNextStep({
      serviceCreditsAvailable: 0,
      serviceCreditsReserved: 0,
      purchaseEnabled: true,
      humanInLoop: true,
    })).toBe("purchase");
    expect(resolvePublicChatServiceCreditNextStep({
      serviceCreditsAvailable: 0,
      serviceCreditsReserved: 0,
      purchaseEnabled: false,
      humanInLoop: true,
    })).toBe("handoff");
    expect(resolvePublicChatServiceCreditNextStep({
      serviceCreditsAvailable: 0,
      serviceCreditsReserved: 0,
      purchaseEnabled: false,
      humanInLoop: false,
    })).toBe("unavailable");
  });

  it("resolves a pending-credit notice when the reservation finishes or releases", () => {
    expect(resolvePublicChatServiceCreditPendingTransition({
      previousReserved: 1,
      serviceCreditsAvailable: 2,
      serviceCreditsReserved: 0,
    })).toBe("available");
    expect(resolvePublicChatServiceCreditPendingTransition({
      previousReserved: 1,
      serviceCreditsAvailable: 0,
      serviceCreditsReserved: 0,
    })).toBe("released");
    expect(resolvePublicChatServiceCreditPendingTransition({
      previousReserved: 1,
      serviceCreditsAvailable: 0,
      serviceCreditsReserved: 1,
    })).toBeNull();
    expect(resolvePublicChatServiceCreditPendingTransition({
      previousReserved: 0,
      serviceCreditsAvailable: 0,
      serviceCreditsReserved: 0,
    })).toBeNull();
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "undefined") {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
