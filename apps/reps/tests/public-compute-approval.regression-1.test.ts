import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Regression: ISSUE-003 — approval-pending Compute replies left public chat busy
// Found by /qa on 2026-07-20
// Report: .gstack/qa-reports/qa-report-localhost-2026-07-20.md
const panelSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/representative-chat-panel.tsx"),
  "utf8",
);
const runEventsSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/chat/runs/[runId]/events/route.ts"),
  "utf8",
);

describe("public Compute approval run lifecycle", () => {
  it("treats waiting approval as a terminal streamed response with a message", () => {
    expect(runEventsSource).toContain(
      'new Set(["waiting_approval", "completed", "failed", "canceled"])',
    );
    expect(panelSource).toContain(
      '["completed", "waiting_approval"].includes(snapshot.status) && snapshot.message',
    );
  });

  it("removes each abort listener after a polling wait settles", () => {
    expect(runEventsSource).toContain('signal.removeEventListener("abort", finish)');
    expect(runEventsSource).toContain("if (signal.aborted) finish()");
  });

  it("keeps newly delivered approval results visible at the bottom of the chat log", () => {
    expect(panelSource).toContain("const keepChatPinnedRef = useRef(true)");
    expect(panelSource).toContain("if (chatLog) chatLog.scrollTop = chatLog.scrollHeight");
    expect(panelSource).toContain("chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight <= 80");
  });
});
