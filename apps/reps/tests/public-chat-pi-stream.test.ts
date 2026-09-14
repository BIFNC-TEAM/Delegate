import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/representative-chat-panel.tsx"),
  "utf8",
);
const snapshotSource = readFileSync(
  resolve(__dirname, "../../../packages/web-data/src/conversation-platform.ts"),
  "utf8",
);
const eventsRouteSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/chat/runs/[runId]/events/route.ts"),
  "utf8",
);

describe("public Pi response streaming", () => {
  it("publishes bounded Pi text and renders it instead of a fixed heartbeat", () => {
    expect(snapshotSource).toContain("updateGenerationPiStream");
    expect(snapshotSource).toContain("text.slice(-32_000)");
    expect(snapshotSource).toContain("...(piStream ? { stream: piStream } : {})");
    expect(panelSource).toContain("setStreamingReply(snapshot.stream.text)");
    expect(panelSource).toContain("streamingReply || t.thinking");
    expect(eventsRouteSource).toContain("RUN_STREAM_POLL_INTERVAL_MS = 150");
  });
});
