import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ message: { findFirst: vi.fn(), findMany: vi.fn() }, representativeMemoryPolicy: { findUnique: vi.fn() }, generationRun: { findFirst: vi.fn() } }));
vi.mock("../src/prisma", () => ({ prisma: db }));
import { loadGenerationV2Task } from "../src/agent-v2-session";
const request = { conversationId: "conversation", representativeId: "rep", representativeVersionId: "version", beforeMessageId: "current", scope: "scope" };
const record = { version: 1, taskId: "task", scope: "scope", status: "waiting_user", inputMessageIds: ["prior"], attemptedWrites: [],
  usage: { modelTurns: 1, toolCalls: 1, attempts: 1, tokens: 10, inputTokens: 8, outputTokens: 2, costUsd: 0, activeMs: 200 } };
beforeEach(() => {
  vi.resetAllMocks();
  db.message.findFirst.mockResolvedValue({ createdAt: new Date(), episodeId: "episode" });
  db.representativeMemoryPolicy.findUnique.mockResolvedValue({ shortTermMemoryEnabled: true });
  db.generationRun.findFirst.mockResolvedValue({ contextSnapshot: { agentTrace: { v2Task: record } } });
  db.message.findMany.mockResolvedValue([{ id: "prior", text: "今天天气？", createdAt: new Date() }]);
});
describe("V2 clarification persistence fences", () => {
  it("restores only same-episode audience messages and cumulative counters", async () => {
    const result = await loadGenerationV2Task(request);
    expect(result?.record.usage.modelTurns).toBe(1);
    expect(db.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ conversationId: "conversation", episodeId: "episode", redactedAt: null, senderType: "AUDIENCE" }) }));
    expect(db.generationRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ representativeVersionId: "version", conversationId: "conversation", episodeId: "episode" }) }));
  });
  it("honors disabled short-term memory", async () => {
    db.representativeMemoryPolicy.findUnique.mockResolvedValue({ shortTermMemoryEnabled: false });
    expect(await loadGenerationV2Task(request)).toBeNull(); expect(db.generationRun.findFirst).not.toHaveBeenCalled();
  });
  it("cannot revive a deleted original question", async () => {
    db.message.findMany.mockResolvedValue([]); expect(await loadGenerationV2Task(request)).toBeNull();
  });
  it("rejects changed identity scope, invalid budget and completed tasks", async () => {
    for (const change of [{ scope: "another-user" }, { status: "completed" }, { usage: { ...record.usage, modelTurns: -1 } }]) {
      db.generationRun.findFirst.mockResolvedValue({ contextSnapshot: { agentTrace: { v2Task: { ...record, ...change } } } });
      expect(await loadGenerationV2Task(request)).toBeNull();
    }
  });
});
