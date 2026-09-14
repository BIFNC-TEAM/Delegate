import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parsePublicChatText } from "../app/reps/[slug]/public-chat-format";

const panelSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/representative-chat-panel.tsx"),
  "utf8",
);
const runEventsSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/chat/runs/[runId]/events/route.ts"),
  "utf8",
);
const conversationEventsSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/chat/events/route.ts"),
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
  it("renders safe structured chat text instead of exposing Markdown markers", () => {
    const text = [
      "**等温线**是气温相等各点的连线。",
      "",
      "---",
      "",
      "- 同一条线上气温相同",
      "- 越密集表示温差越大",
      "",
      "<script>alert(1)</script>",
    ].join("\n");

    expect(parsePublicChatText(text)).toEqual([
      { kind: "paragraph", text: "**等温线**是气温相等各点的连线。" },
      { kind: "separator" },
      {
        kind: "unordered-list",
        items: ["同一条线上气温相同", "越密集表示温差越大"],
      },
      { kind: "paragraph", text: "<script>alert(1)</script>" },
    ]);
    expect(panelSource).not.toContain("<p>{message.text}</p>");
    expect(panelSource).toContain("<PublicChatText text={message.text} />");
    expect(panelSource).toContain("renderPublicChatInline");
    expect(panelSource).not.toContain("dangerouslySetInnerHTML");
  });

  it("keeps the run stream alive beyond the model timeout and emits heartbeats", () => {
    expect(runEventsSource).toContain("RUN_STREAM_WINDOW_MS = 300_000");
    expect(runEventsSource).toContain(": keep-alive");
  });

  it("allows EventSource to reconnect before declaring a reply timeout", () => {
    expect(panelSource).toContain("RUN_SUBSCRIPTION_DEADLINE_MS = 330_000");
    expect(panelSource).toContain("EventSource reconnects automatically");
    expect(panelSource).not.toContain('source.addEventListener("error", () => {\n      source.close();');
  });

  it("settles the composer when the conversation stream delivers the current reply", () => {
    expect(panelSource).toContain("activeClientMessageIdRef");
    expect(panelSource).toContain(
      "message.generationInputClientMessageId === activeClientMessageId",
    );
    expect(panelSource).toContain("settleActiveRun()");
    expect(panelSource).not.toContain("isPublicTaskStreamActive");
    expect(panelSource).not.toContain("isPublicTurnStreamActive");
  });

  it("uses the Pi GenerationRun terminal state as the stream authority", () => {
    expect(runEventsSource).toContain(
      "if (terminalStates.has(snapshot.status)) break;",
    );
    expect(runEventsSource).not.toContain("continuouslyStreamingTaskStates");
    expect(runEventsSource).not.toContain("snapshot.taskProgress");
    expect(runEventsSource).not.toContain("snapshot.turnProgress");
  });

  it("settles the Pi run subscription from persisted terminal snapshots", () => {
    expect(panelSource).toContain(
      '["completed", "waiting_approval"].includes(snapshot.status)',
    );
    expect(panelSource).toContain(
      '["failed", "canceled"].includes(snapshot.status)',
    );
    expect(panelSource).toContain("setStreamingReply(snapshot.stream.text)");
  });

  it("does not retain the retired Planner or Delegation progress UI", () => {
    expect(panelSource).not.toContain("representative-progress-dock");
    expect(panelSource).not.toContain("taskProgress");
    expect(panelSource).not.toContain("turnProgress");
    expect(panelSource).not.toContain("formatPublicTurnStage");
  });

  it("removes abort listeners after each conversation heartbeat wait settles", () => {
    expect(conversationEventsSource).toContain('signal.removeEventListener("abort", finish)');
    expect(conversationEventsSource).toContain("if (signal.aborted) finish()");
  });

  it.each([
    ["conversation", conversationEventsSource, "getPublicConversationHistory"],
    ["run", runEventsSource, "getPublicGenerationRunSnapshot"],
  ])(
    "revalidates the captured principal at most every two seconds in the %s stream",
    (_name, source, protectedRead) => {
      expect(source).toContain(
        "PRINCIPAL_REVALIDATION_INTERVAL_MS = 2_000",
      );
      expect(source).toContain("await revalidate()");
      expect(source.indexOf("await revalidate()")).toBeLessThan(
        source.indexOf(`${protectedRead}({`),
      );
      expect(source).toContain('error: "stream_failed"');
      expect(source).toContain("controller.close()");
    },
  );

  it("prevents SDK retries from multiplying the configured provider timeout", () => {
    expect(openAiSource).toContain("maxRetries: 0");
    expect(anthropicSource).toContain("maxRetries: 0");
  });
});
