import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/representative-chat-panel.tsx"),
  "utf8",
);
const runEventsSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/chat/runs/[runId]/events/route.ts"),
  "utf8",
);
const openAiSource = readFileSync(
  resolve(__dirname, "../../../packages/model-runtime/src/openai.ts"),
  "utf8",
);
const anthropicSource = readFileSync(
  resolve(__dirname, "../../../packages/model-runtime/src/anthropic.ts"),
  "utf8",
);

describe("public chat reply resilience", () => {
  it("keeps the run stream alive beyond the model timeout and emits heartbeats", () => {
    expect(runEventsSource).toContain("RUN_STREAM_WINDOW_MS = 120_000");
    expect(runEventsSource).toContain(": keep-alive");
  });

  it("allows EventSource to reconnect before declaring a reply timeout", () => {
    expect(panelSource).toContain("RUN_SUBSCRIPTION_DEADLINE_MS = 150_000");
    expect(panelSource).toContain("EventSource reconnects automatically");
    expect(panelSource).not.toContain('source.addEventListener("error", () => {\n      source.close();');
  });

  it("prevents SDK retries from multiplying the configured provider timeout", () => {
    expect(openAiSource).toContain("maxRetries: 0");
    expect(anthropicSource).toContain("maxRetries: 0");
  });
});
