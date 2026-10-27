import { describe, expect, it } from "vitest";

import { mergeGenerationCompletionContext, resolveGenerationAgentVariant } from "../src/conversation-platform";

describe("generation Agent trace persistence", () => {
  it("pins running versions across configuration changes and keeps existing PI work on PI", () => {
    expect(resolveGenerationAgentVariant({})).toBe("v2");
    expect(resolveGenerationAgentVariant({})).toBe("v2");
    expect(resolveGenerationAgentVariant({ agentVariant: "v2" })).toBe("v2");
    expect(resolveGenerationAgentVariant({ piExecutionProtocol: "goal_v2" })).toBe("pi");
    expect(resolveGenerationAgentVariant({ agentVariant: "pi" })).toBe("pi");
  });
  it("preserves Pi operational timing evidence alongside the runtime outcome", () => {
    const merged = mergeGenerationCompletionContext(
      { piStream: { version: 1, sequence: 2, text: "partial" } },
      {
        runtimeOutcome: { mode: "model" },
        agentTrace: {
          runtime: "delegate-pi-runtime.1",
          traceId: "trace-1",
          status: "completed",
          firstModelEventMs: 12,
          firstTextMs: 25,
          totalDurationMs: 90,
          modelCalls: 2,
          toolCalls: 1,
          events: [{ type: "run.completed" }],
          spans: [{ module: "model", durationMs: 40 }],
        },
      },
    );

    expect(merged).toMatchObject({
      piStream: { sequence: 2, text: "partial" },
      runtimeOutcome: { version: 1, mode: "model" },
      agentTrace: {
        runtime: "delegate-pi-runtime.1",
        traceId: "trace-1",
        firstTextMs: 25,
        modelCalls: 2,
        toolCalls: 1,
        spans: [{ module: "model", durationMs: 40 }],
      },
    });
  });
});
