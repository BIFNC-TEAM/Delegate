import { describe, expect, it, vi } from "vitest";

import { createObservedProviderFetch } from "../src/pi/provider";
import type { PiModelAttemptEvent } from "../src/pi/types";

describe("Pi provider attempt observation", () => {
  it("records each physical HTTP attempt and whether Pi will retry it", async () => {
    const events: PiModelAttemptEvent[] = [];
    const baseFetch = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const observed = createObservedProviderFetch({
      fetch: baseFetch,
      observer: (event) => events.push(event),
      logicalCallId: "turn-1",
      maximumRetries: 1,
      maximumRetryDelayMs: 2_000,
    });

    await observed("https://provider.test/v1/chat");
    await observed("https://provider.test/v1/chat");

    expect(events).toEqual([
      { type: "start", logicalCallId: "turn-1", attempt: 1 },
      { type: "end", logicalCallId: "turn-1", attempt: 1, status: "error", httpStatus: 503, willRetry: true },
      { type: "start", logicalCallId: "turn-1", attempt: 2 },
      { type: "end", logicalCallId: "turn-1", attempt: 2, status: "ok", httpStatus: 200 },
    ]);
  });

  it("does not report a retry when the provider delay exceeds the configured cap", async () => {
    const events: PiModelAttemptEvent[] = [];
    const observed = createObservedProviderFetch({
      fetch: vi.fn(async () => new Response("slow down", {
        status: 429,
        headers: { "retry-after-ms": "5000" },
      })),
      observer: (event) => events.push(event),
      logicalCallId: "turn-delay",
      maximumRetries: 1,
      maximumRetryDelayMs: 2_000,
    });

    await observed("https://provider.test/v1/chat");

    expect(events.at(-1)).toEqual({
      type: "end",
      logicalCallId: "turn-delay",
      attempt: 1,
      status: "error",
      httpStatus: 429,
    });
  });
});
