import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { inferDeterministicNaturalLanguageComputePlan } from "../../../packages/model-runtime/src/compute-planner";

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
    expect(panelSource).toContain(
      "!isPublicTaskStreamActive(payload.taskProgress ?? undefined)",
    );
    expect(panelSource).toContain(
      "!isPublicTurnStreamActive(payload.turnProgress ?? undefined)",
    );
  });

  it("keeps live multi-step tasks visible instead of stopping at the first run result", () => {
    expect(runEventsSource).toContain("continuouslyStreamingTaskStates");
    expect(runEventsSource).toContain("snapshot.taskProgress");
    expect(panelSource).toContain("representative-task-progress");
    expect(panelSource).toContain("taskProgress.steps.map");
    expect(panelSource).toContain("setTaskProgress(payload.taskProgress ?? null)");
  });

  it("streams and renders persisted TurnPlan execution progress", () => {
    expect(runEventsSource).toContain("snapshot.turnProgress?.status");
    expect(panelSource).toContain("representative-turn-progress");
    expect(panelSource).toContain("turnProgress.steps.map");
    expect(panelSource).toContain("setTurnProgress(payload.turnProgress ?? null)");
    expect(panelSource).toContain("formatPublicTurnStage");
    expect(panelSource).toContain("formatPublicTurnElapsed");
  });

  it("releases the composer when a task is waiting for audience clarification", () => {
    const panelActiveStates = panelSource.slice(
      panelSource.indexOf("function isPublicTaskStreamActive"),
      panelSource.indexOf("function formatPublicTaskStatus"),
    );
    const streamActiveStates = runEventsSource.slice(
      runEventsSource.indexOf("const continuouslyStreamingTaskStates"),
      runEventsSource.indexOf("const RUN_STREAM_WINDOW_MS"),
    );
    expect(panelActiveStates).not.toContain('"clarifying"');
    expect(streamActiveStates).not.toContain('"clarifying"');
    expect(panelSource).toContain('{ taskStatus: taskProgress.status }');
    expect(panelSource).toContain('"等待你补充"');
    expect(panelSource).toContain('"等待负责人审批"');
  });

  it("turns a clarified generic file request into a governed write step", () => {
    expect(inferDeterministicNaturalLanguageComputePlan([
      "原始任务：请生成一个文本文件",
      "待补充：请说明要生成或保存的具体内容；文件位置由系统自动管理。",
      "用户补充：内容为：赤道是0°纬线，把地球分为南北两个半球。",
    ].join("\n"))).toMatchObject({
      kind: "execution",
      steps: [{
        capability: "write",
        path: expect.stringMatching(/^outputs\/file-[a-f0-9]{8}\.txt$/),
        content: "赤道是0°纬线，把地球分为南北两个半球。",
      }],
    });
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
