import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { PiModelBinding } from "../src/pi/types";
import { createReviewerComparisonBinding } from "../scripts/reviewer-comparison-binding";

function binding(id: string) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses([fauxAssistantMessage(id), fauxAssistantMessage(id)]);
  const models = createModels(); models.setProvider(faux.provider);
  const stream = vi.fn(models.streamSimple.bind(models));
  const observed = vi.fn((_observer?: unknown, _before?: unknown) => stream);
  const value: PiModelBinding = { model: faux.getModel(), provider: id, modelId: id,
    streamFn: stream, createObservedStreamFn: observed };
  return { value, stream, observed };
}
const review = {
  systemPrompt: "You verify a candidate answer against the CURRENT VALID request",
  messages: [{ role: "user" as const, timestamp: 1, content: JSON.stringify({ candidate: "candidate", goal: "question", observations: [] }) }],
};

describe("isolated reviewer comparison binding", () => {
  it("changes only the reviewer model and preserves the exact payload, limits and abort signal", async () => {
    const primary = binding("primary"); const reviewer = binding("reviewer");
    const model = createReviewerComparisonBinding(primary.value, reviewer.value);
    const options = { maxTokens: 1400, signal: new AbortController().signal };
    await (await model.streamFn(model.model, review, options)).result();
    expect(primary.stream).not.toHaveBeenCalled(); expect(reviewer.stream).toHaveBeenCalledOnce();
    expect(reviewer.stream.mock.calls[0]).toEqual([reviewer.value.model, review, options]);
    expect(reviewer.stream.mock.calls[0]![1]).toBe(review);
    expect(model.model).toBe(primary.value.model); expect(model.provider).toBe("primary");
  });

  it.each([
    { ...review, systemPrompt: "CURRENT TASK: main Agent" },
    { ...review, messages: [{ role: "user" as const, timestamp: 1, content: "You verify a candidate answer" }] },
    { ...review, messages: [{ role: "assistant" as const, content: [], api: "faux", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: 1 }] },
  ])("does not redirect primary/user text or incomplete lookalike packets", async context => {
    const primary = binding("primary"); const reviewer = binding("reviewer");
    const model = createReviewerComparisonBinding(primary.value, reviewer.value);
    await (await model.streamFn(model.model, context)).result();
    expect(primary.stream).toHaveBeenCalledOnce(); expect(reviewer.stream).not.toHaveBeenCalled();
  });

  it("preserves observed-stream hooks and routes once without silently falling back on review errors", async () => {
    const primary = binding("primary"); const reviewer = binding("reviewer");
    reviewer.stream.mockImplementation(() => { throw new Error("synthetic_review_failure"); });
    const observer = vi.fn(); const before = vi.fn(async () => undefined);
    const model = createReviewerComparisonBinding(primary.value, reviewer.value);
    const stream = model.createObservedStreamFn!(observer, before);
    expect(primary.observed).toHaveBeenCalledWith(observer, before);
    expect(reviewer.observed).toHaveBeenCalledWith(observer, before);
    expect(() => stream(model.model, review)).toThrow("synthetic_review_failure");
    expect(primary.stream).not.toHaveBeenCalled(); expect(reviewer.stream).toHaveBeenCalledOnce();
  });
});
