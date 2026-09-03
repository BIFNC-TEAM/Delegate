import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    delegationTask: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    delegationTaskStep: { update: vi.fn() },
    delegationTaskEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
        operation(tx)),
    },
  };
});

vi.mock("../src/prisma", () => ({ prisma: database.prisma }));

import {
  closeConversationClarifyingDelegationTask,
  readPendingClarificationSpec,
} from "../src/delegation-tasks";

const pending = {
  protocolVersion: 1 as const,
  source: "turn_plan_v3" as const,
  originInputMessageId: "message-1",
  representativeVersionId: "version-1",
  objective: "查询今天的天气",
  capabilityPins: [{
    key: "mcp.weather.search",
    version: "1",
    definitionHash: `sha256:${"a".repeat(64)}`,
  }],
  missingSlots: [{
    id: "location",
    argumentPath: "/actions/0/arguments/location",
    schema: { type: "string" },
    prompt: "请补充地点。",
  }],
  clarificationCount: 0,
  createdAt: "2026-09-03T00:00:00.000Z",
  expiresAt: "2026-09-03T00:30:00.000Z",
};

describe("pending clarification persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.tx.delegationTaskEvent.findFirst.mockResolvedValue(null);
  });

  it("reads the versioned spec from task or clarification-step snapshots", () => {
    expect(readPendingClarificationSpec({
      contextSnapshot: { pendingClarification: pending },
      steps: [],
    })).toEqual(pending);
    expect(readPendingClarificationSpec({
      contextSnapshot: {},
      steps: [{
        kind: "CLARIFICATION",
        inputSnapshot: { pendingClarification: pending },
      }],
    })).toEqual(pending);
    expect(readPendingClarificationSpec({ contextSnapshot: {}, steps: [] }))
      .toBeNull();
  });

  it("atomically supersedes the pending task when a new intent replaces it", async () => {
    database.tx.delegationTask.findFirst.mockResolvedValue({
      id: "task-1",
      steps: [{ id: "step-1" }],
    });

    await expect(closeConversationClarifyingDelegationTask({
      taskId: "task-1",
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      episodeId: "episode-1",
      inputMessageId: "message-2",
      outcome: "superseded",
      reasonCode: "standalone_new_request",
    })).resolves.toBe(true);

    expect(database.tx.delegationTask.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({
        status: "CANCELED",
        nextActionBy: "NONE",
        blockingReason: "standalone_new_request",
      }),
    });
    expect(database.tx.delegationTaskStep.update).toHaveBeenCalledWith({
      where: { id: "step-1" },
      data: expect.objectContaining({ status: "CANCELED" }),
    });
    expect(database.tx.delegationTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "task.superseded_by_new_intent",
        actorType: "AUDIENCE",
        fromStatus: "CLARIFYING",
        toStatus: "CANCELED",
      }),
    });
  });
});
