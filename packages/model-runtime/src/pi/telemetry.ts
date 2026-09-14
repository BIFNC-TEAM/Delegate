import { randomUUID } from "node:crypto";

import type {
  PiModule,
  PiRuntimeEvent,
  PiSpan,
  PiSpanStatus,
} from "./types";

export type MonotonicClock = {
  now(): number;
};

const systemClock: MonotonicClock = {
  now: () => performance.now(),
};

type OpenSpan = Omit<PiSpan, "durationMs" | "status"> & {
  startAbsoluteMs: number;
};

export class PiTelemetry {
  readonly traceId: string;
  readonly runId: string;
  readonly caseId: string | undefined;
  readonly events: PiRuntimeEvent[] = [];
  readonly spans: PiSpan[] = [];
  readonly startedAtMs: number;
  private readonly open = new Map<string, OpenSpan>();
  private terminal = false;

  constructor(input: {
    runId: string;
    caseId?: string;
    traceId?: string;
    clock?: MonotonicClock;
    onEvent?: (event: PiRuntimeEvent) => void | Promise<void>;
  }) {
    this.traceId = input.traceId ?? randomUUID();
    this.runId = input.runId;
    this.caseId = input.caseId;
    this.clock = input.clock ?? systemClock;
    this.onEvent = input.onEvent;
    this.startedAtMs = this.clock.now();
  }

  private readonly clock: MonotonicClock;
  private readonly onEvent: ((event: PiRuntimeEvent) => void | Promise<void>) | undefined;

  offset(): number {
    return Math.max(0, this.clock.now() - this.startedAtMs);
  }

  start(input: {
    module: PiModule;
    operation: string;
    parentSpanId?: string;
    purpose?: string;
    logicalCallId?: string;
    attempt?: number;
    provider?: string;
    model?: string;
    toolName?: string;
    skillId?: string;
    queueMs?: number;
    retryBackoffMs?: number;
    coldStart?: boolean;
  }): string {
    const spanId = randomUUID();
    const startAbsoluteMs = this.clock.now();
    this.open.set(spanId, {
      traceId: this.traceId,
      runId: this.runId,
      ...(this.caseId ? { caseId: this.caseId } : {}),
      spanId,
      ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
      module: input.module,
      operation: input.operation,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(input.logicalCallId ? { logicalCallId: input.logicalCallId } : {}),
      attempt: input.attempt ?? 1,
      startOffsetMs: Math.max(0, startAbsoluteMs - this.startedAtMs),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.skillId ? { skillId: input.skillId } : {}),
      ...(input.queueMs !== undefined ? { queueMs: input.queueMs } : {}),
      ...(input.retryBackoffMs !== undefined
        ? { retryBackoffMs: input.retryBackoffMs }
        : {}),
      ...(input.coldStart !== undefined ? { coldStart: input.coldStart } : {}),
      startAbsoluteMs,
    });
    return spanId;
  }

  end(spanId: string, input: {
    status: PiSpanStatus;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheHit?: boolean;
    resultRef?: string;
    error?: string;
  }): PiSpan | null {
    const active = this.open.get(spanId);
    if (!active) return null;
    this.open.delete(spanId);
    const { startAbsoluteMs, ...base } = active;
    const span: PiSpan = {
      ...base,
      durationMs: Math.max(0, this.clock.now() - startAbsoluteMs),
      status: input.status,
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.totalTokens !== undefined ? { totalTokens: input.totalTokens } : {}),
      ...(input.cacheHit !== undefined ? { cacheHit: input.cacheHit } : {}),
      ...(input.resultRef ? { resultRef: input.resultRef } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
    this.spans.push(span);
    return span;
  }

  async event(input: Omit<PiRuntimeEvent, "traceId" | "runId" | "atOffsetMs">) {
    if (input.type.startsWith("run.")) {
      if (this.terminal) return;
      this.terminal = true;
    }
    const event: PiRuntimeEvent = {
      ...input,
      traceId: this.traceId,
      runId: this.runId,
      atOffsetMs: this.offset(),
    };
    this.events.push(event);
    await this.onEvent?.(event);
  }

  closeOpen(status: PiSpanStatus, error?: string) {
    for (const spanId of [...this.open.keys()]) {
      this.end(spanId, { status, ...(error ? { error } : {}) });
    }
  }
}

export function calculateSelfDurations(spans: readonly PiSpan[]): PiSpan[] {
  return spans.map((span) => {
    const parentStart = span.startOffsetMs;
    const parentEnd = parentStart + span.durationMs;
    const childIntervals = spans
      .filter((child) => child.parentSpanId === span.spanId)
      .map((child) => [
        Math.max(parentStart, child.startOffsetMs),
        Math.min(parentEnd, child.startOffsetMs + child.durationMs),
      ] as const)
      .filter(([start, end]) => end > start)
      .sort((left, right) => left[0] - right[0]);
    let covered = 0;
    let cursor = Number.NEGATIVE_INFINITY;
    for (const [start, end] of childIntervals) {
      if (end <= cursor) continue;
      covered += end - Math.max(start, cursor);
      cursor = end;
    }
    return {
      ...span,
      selfDurationMs: Math.max(0, span.durationMs - covered),
    };
  });
}

export function nearestRank(values: readonly number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)]!;
}
