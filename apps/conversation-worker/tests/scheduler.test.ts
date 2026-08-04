import { describe, expect, it, vi } from "vitest";

import type { ConversationWorkerConfig } from "../src/config";
import { startConversationWorkerLoops } from "../src/scheduler";

const config: ConversationWorkerConfig = {
  port: 4040,
  pollMs: 500,
  telegramConversationPlatformMode: "worker",
  telegramRequestTimeoutMs: 15_000,
  outboxProcessingLeaseMs: 5 * 60_000,
};

describe("conversation worker scheduler", () => {
  it("keeps pumping memory while a conversation call never resolves", async () => {
    const scheduled: Array<() => void> = [];
    const processMemory = vi.fn(async () => ({ processed: false as const }));
    const conversationNeverCompletes = new Promise<never>(() => undefined);
    const processConversation = vi.fn(() => conversationNeverCompletes);
    const scheduler = startConversationWorkerLoops(config, {
      processMemory,
      processConversation,
      schedule: (callback) => {
        scheduled.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: vi.fn(),
    });

    await vi.waitFor(() => expect(processMemory).toHaveBeenCalledTimes(1));
    expect(processConversation).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));

    scheduled.shift()?.();
    await vi.waitFor(() => expect(processMemory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    scheduled.shift()?.();
    await vi.waitFor(() => expect(processMemory).toHaveBeenCalledTimes(3));

    expect(processConversation).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot().conversation.active).toBe(true);
    scheduler.stop();
  });

  it("tracks each lane independently", async () => {
    const scheduled: Array<() => void> = [];
    const now = vi.fn()
      .mockReturnValueOnce(new Date("2026-08-04T00:00:01.000Z"))
      .mockReturnValueOnce(new Date("2026-08-04T00:00:02.000Z"));
    const scheduler = startConversationWorkerLoops(config, {
      processMemory: vi.fn(async () => ({
        processed: true as const,
        runId: "memory-run",
        status: "completed" as const,
        attemptCount: 1,
      })),
      processConversation: vi.fn(async () => ({
        processed: true as const,
        runId: "conversation-run",
        status: "completed" as const,
      })),
      schedule: (callback) => {
        scheduled.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: vi.fn(),
      now,
    });

    await vi.waitFor(() => {
      expect(scheduler.snapshot()).toEqual({
        memory: {
          active: false,
          lastProcessedAt: "2026-08-04T00:00:01.000Z",
          lastError: null,
        },
        conversation: {
          active: false,
          lastProcessedAt: "2026-08-04T00:00:02.000Z",
          lastError: null,
        },
      });
    });
    expect(scheduled).toHaveLength(2);
    scheduler.stop();
  });

  it("does not expose a memory exception or suppress conversation work", async () => {
    const scheduler = startConversationWorkerLoops(config, {
      processMemory: vi.fn(async () => {
        throw new Error("private memory database detail");
      }),
      processConversation: vi.fn(async () => ({
        processed: true as const,
        runId: "conversation-run",
        status: "completed" as const,
      })),
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearSchedule: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(scheduler.snapshot()).toMatchObject({
        memory: {
          active: false,
          lastError: "memory_extraction_tick_failed",
        },
        conversation: {
          active: false,
          lastProcessedAt: expect.any(String),
          lastError: null,
        },
      });
    });
    expect(JSON.stringify(scheduler.snapshot())).not.toContain("private memory");
    scheduler.stop();
  });

  it("surfaces retrying extraction with a stable lane error", async () => {
    const scheduler = startConversationWorkerLoops(config, {
      processMemory: vi.fn(async () => ({
        processed: true as const,
        runId: "memory-run",
        status: "retrying" as const,
        attemptCount: 2,
        errorCode: "memory_extraction_processing_failed",
        availableAt: new Date("2026-08-04T00:00:01.000Z"),
      })),
      processConversation: vi.fn(async () => ({ processed: false as const })),
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearSchedule: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(scheduler.snapshot().memory).toMatchObject({
        active: false,
        lastError: "memory_extraction_processing_failed",
      });
    });
    scheduler.stop();
  });
});
