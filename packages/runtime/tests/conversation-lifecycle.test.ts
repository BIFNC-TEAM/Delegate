import { describe, expect, it } from "vitest";

import {
  applyRuntimePolicyOverlays,
  assertConversationEpisodeTransition,
  buildMessageRetentionExpiry,
  buildRedactionPurgeAt,
  resolveInboundEpisodeAction,
  resolveMessageEditAction,
} from "../src/conversation-lifecycle";

describe("conversation lifecycle", () => {
  it("reopens resolved and archived work without creating a new channel conversation", () => {
    expect(resolveInboundEpisodeAction("resolved")).toBe("start_new_episode");
    expect(resolveInboundEpisodeAction("archived")).toBe("reopen");
    expect(resolveInboundEpisodeAction("human_active")).toBe("hold_for_operator");
  });

  it("rejects unsafe state jumps", () => {
    expect(() => assertConversationEpisodeTransition("active", "archived")).toThrow(
      "cannot transition",
    );
    expect(() => assertConversationEpisodeTransition("resolved", "archived")).not.toThrow();
  });

  it("maps message edits to the correct run behavior", () => {
    expect(resolveMessageEditAction("queued")).toBe("replace_queued_run");
    expect(resolveMessageEditAction("processing")).toBe("cancel_and_requeue");
    expect(resolveMessageEditAction("completed")).toBe("preserve_reply");
    expect(resolveMessageEditAction("failed")).toBe("update_only");
  });

  it("builds the confirmed retention windows", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    expect(buildMessageRetentionExpiry(now).toISOString()).toBe("2027-01-12T00:00:00.000Z");
    expect(buildRedactionPurgeAt(now).toISOString()).toBe("2026-07-23T00:00:00.000Z");
  });

  it("applies active policy overlays in priority order", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const resolved = applyRuntimePolicyOverlays(
      {
        publicMode: true,
        tools: { browser: true, mcp: true },
      },
      [
        {
          enabled: true,
          priority: 100,
          startsAt: new Date("2026-07-15T00:00:00.000Z"),
          payload: { tools: { browser: false } },
        },
        {
          enabled: true,
          priority: 200,
          startsAt: new Date("2026-07-15T00:00:00.000Z"),
          payload: { publicMode: false },
        },
        {
          enabled: true,
          priority: 300,
          startsAt: new Date("2026-07-15T00:00:00.000Z"),
          expiresAt: new Date("2026-07-15T12:00:00.000Z"),
          payload: { ignored: true },
        },
      ],
      now,
    );

    expect(resolved).toEqual({
      publicMode: false,
      tools: { browser: false, mcp: true },
    });
  });
});
