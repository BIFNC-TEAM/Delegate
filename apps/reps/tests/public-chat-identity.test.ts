import { describe, expect, it } from "vitest";

import {
  createPublicChatSessionState,
  getPublicChatCookieName,
  readPublicChatSessionState,
  writePublicChatSessionState,
} from "../app/reps/[slug]/public-chat";

describe("public chat audience identity cookie", () => {
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
});
