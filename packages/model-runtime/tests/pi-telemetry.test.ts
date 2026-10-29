import { describe, expect, it, vi } from "vitest";

import {
  calculateSelfDurations,
  nearestRank,
  PiTelemetry,
  type MonotonicClock,
} from "../src/pi";

class VirtualClock implements MonotonicClock {
  value = 0;
  now() { return this.value; }
  advance(milliseconds: number) { this.value += milliseconds; }
}

describe("Pi telemetry timing contracts", () => {
  it("minimizes arbitrary nested inputs before retained events and audit callbacks", async () => {
    const onEvent = vi.fn();
    const telemetry = new PiTelemetry({ runId: "audit", onEvent });
    const secret = "SYNTHETIC_PRIVATE_CANARY";
    const data = { toolCallId: "call-1", arguments: { query: secret, nested: [{ password: secret }], url: `https://example.invalid/?token=${secret}` }, sourceCount: 2, extra: { body: secret } };
    await telemetry.event({ type: "tool.started", module: "mcp", data });
    expect(JSON.stringify(telemetry.events)).not.toContain(secret);
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain(secret);
    expect(telemetry.events[0]?.data).toMatchObject({ sourceCount: 2, argumentCount: 3 });
    expect(data.arguments.query).toBe(secret);
  });

  it("keeps response text in the delivery callback but excludes it from audit history", async () => {
    const onEvent = vi.fn();
    const telemetry = new PiTelemetry({ runId: "audit", onEvent });
    const delta = "SYNTHETIC_PRIVATE_RESPONSE";
    await telemetry.event({ type: "response.delta", module: "response", delta });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ delta }));
    expect(JSON.stringify(telemetry.events)).not.toContain(delta);
    expect(telemetry.events[0]).not.toHaveProperty("delta");
  });

  it("removes raw provider errors and URL credentials from span diagnostics", () => {
    const telemetry = new PiTelemetry({ runId: "audit" });
    const secret = "SYNTHETIC_PRIVATE_SPAN";
    const spanId = telemetry.start({ module: "mcp", operation: "call" });
    telemetry.end(spanId, { status: "error", error: `request failed password=${secret}`, resultRef: `https://user:${secret}@example.invalid/private?q=${secret}` });
    expect(JSON.stringify(telemetry.spans)).not.toContain(secret);
    expect(telemetry.spans[0]?.error).toBe("operation_failed");
    expect(telemetry.spans[0]?.resultRef).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("measures serial spans and request elapsed time", () => {
    const clock = new VirtualClock();
    const telemetry = new PiTelemetry({ runId: "serial", clock });
    for (const duration of [100, 200, 300]) {
      const span = telemetry.start({ module: "orchestration", operation: "serial" });
      clock.advance(duration);
      telemetry.end(span, { status: "ok" });
    }
    expect(telemetry.spans.map((span) => span.durationMs)).toEqual([100, 200, 300]);
    expect(telemetry.offset()).toBe(600);
  });

  it("does not add parallel child durations as wall time", () => {
    const spans = calculateSelfDurations([
      span("a", 0, 100),
      span("b", 0, 200),
      span("c", 0, 300),
    ]);
    expect(spans.reduce((total, item) => total + item.durationMs, 0)).toBe(600);
    expect(Math.max(...spans.map((item) => item.startOffsetMs + item.durationMs))).toBe(300);
  });

  it("subtracts the union of overlapping child intervals from a parent", () => {
    const calculated = calculateSelfDurations([
      span("parent", 0, 300),
      span("a", 0, 200, "parent"),
      span("b", 100, 200, "parent"),
    ]);
    expect(calculated.find((item) => item.spanId === "parent")?.selfDurationMs).toBe(0);
  });

  it("uses nearest-rank percentiles", () => {
    expect(nearestRank([100, 200, 300, 400, 500], 0.5)).toBe(300);
    expect(nearestRank([100, 200, 300, 400, 500], 0.95)).toBe(500);
    expect(nearestRank([], 0.95)).toBeNull();
  });

  it("records failed attempt, retry backoff, and successful attempt separately", () => {
    const clock = new VirtualClock();
    const telemetry = new PiTelemetry({ runId: "retry", clock });
    const failed = telemetry.start({
      module: "mcp",
      operation: "orders.get",
      logicalCallId: "logical",
      attempt: 1,
    });
    clock.advance(100);
    telemetry.end(failed, { status: "error" });
    const backoff = telemetry.start({
      module: "wait",
      operation: "retry_backoff",
      logicalCallId: "logical",
      attempt: 1,
      retryBackoffMs: 200,
    });
    clock.advance(200);
    telemetry.end(backoff, { status: "ok" });
    const succeeded = telemetry.start({
      module: "mcp",
      operation: "orders.get",
      logicalCallId: "logical",
      attempt: 2,
    });
    clock.advance(300);
    telemetry.end(succeeded, { status: "ok" });

    expect(telemetry.offset()).toBe(600);
    expect(telemetry.spans.filter((item) => item.module === "mcp")
      .reduce((sum, item) => sum + item.durationMs, 0)).toBe(400);
    expect(telemetry.spans.find((item) => item.module === "wait")?.durationMs).toBe(200);
  });

  it("closes errors and cancellation once and emits only one terminal event", async () => {
    const clock = new VirtualClock();
    const telemetry = new PiTelemetry({ runId: "terminal", clock });
    const errorSpan = telemetry.start({ module: "model", operation: "generate" });
    clock.advance(50);
    telemetry.end(errorSpan, { status: "error", error: "provider failed" });
    const cancelSpan = telemetry.start({ module: "sandbox", operation: "execute" });
    clock.advance(25);
    telemetry.closeOpen("cancelled", "user cancelled");
    await telemetry.event({ type: "run.cancelled", module: "request" });
    await telemetry.event({ type: "run.failed", module: "request" });

    expect(telemetry.spans.find((item) => item.spanId === cancelSpan)?.status).toBe("cancelled");
    expect(telemetry.events.filter((event) => event.type.startsWith("run."))).toHaveLength(1);
  });
});

function span(id: string, start: number, duration: number, parentSpanId?: string) {
  return {
    traceId: "trace",
    runId: "run",
    spanId: id,
    ...(parentSpanId ? { parentSpanId } : {}),
    module: "orchestration" as const,
    operation: id,
    attempt: 1,
    startOffsetMs: start,
    durationMs: duration,
    status: "ok" as const,
  };
}
