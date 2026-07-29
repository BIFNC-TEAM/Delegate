import { describe, expect, it } from "vitest";

import { formatGenerationRunPresentation } from "../app/dashboard/dashboard-inbox-run-status";

describe("dashboard inbox generation run status", () => {
  it("shows a textual warning for a model-unavailable fallback", () => {
    expect(formatGenerationRunPresentation({
      id: "run-fallback",
      status: "completed",
      runtimeOutcome: {
        mode: "fallback",
        fallbackReason: "model_unavailable",
      },
      createdAt: "2026-07-29T01:00:00.000Z",
    }, "zh")).toEqual({
      label: "已发送基础回复",
      detail: "模型服务当前不可用；请检查配置后重新测试。",
      markerClass: "is-waiting_human",
    });
  });

  it("uses safe English copy for provider failures", () => {
    const presentation = formatGenerationRunPresentation({
      id: "run-provider-failed",
      status: "completed",
      runtimeOutcome: {
        mode: "fallback",
        fallbackReason: "provider_failed",
      },
      createdAt: "2026-07-29T01:00:00.000Z",
    }, "en");

    expect(presentation).toEqual({
      label: "Basic reply sent",
      detail: "The model request did not complete; try again later.",
      markerClass: "is-waiting_human",
    });
  });

  it("keeps successful model runs in the normal completed state", () => {
    expect(formatGenerationRunPresentation({
      id: "run-model",
      status: "completed",
      model: "qwen-plus",
      runtimeOutcome: { mode: "model" },
      createdAt: "2026-07-29T01:00:00.000Z",
    }, "en")).toEqual({
      label: "Completed",
      detail: "qwen-plus",
      markerClass: "is-completed",
    });
  });
});
