import { MessageSenderType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  message: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  generationRun: { findFirst: vi.fn(), findMany: vi.fn() },
  representativeMemoryPolicy: {
    findUnique: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: {
    message: mocks.message,
    representativeMemoryPolicy: mocks.representativeMemoryPolicy,
    generationRun: mocks.generationRun,
  },
}));

import { loadGenerationRecentTurns } from "../src/conversation-platform";

describe("generation recent-turn recall boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generationRun.findFirst.mockResolvedValue(null);
    mocks.generationRun.findMany.mockResolvedValue([]);
    mocks.message.findFirst.mockResolvedValue(null);
    mocks.message.findUnique.mockResolvedValue({
      createdAt: new Date("2026-08-04T10:05:00.000Z"),
      episodeId: "episode-1",
    });
    mocks.representativeMemoryPolicy.findUnique.mockResolvedValue({
      shortTermMemoryEnabled: true,
    });
    mocks.message.findMany.mockResolvedValue([
      {
        id: "message-first",
        senderType: MessageSenderType.AUDIENCE,
        text: "First audience question",
        createdAt: new Date("2026-08-04T10:00:00.000Z"),
      },
      {
        id: "message-second",
        senderType: MessageSenderType.AUDIENCE,
        text: "Second audience question",
        createdAt: new Date("2026-08-04T10:01:00.000Z"),
      },
    ]);
  });

  it("queries only audience-authored messages and emits inbound turns", async () => {
    const recentTurns = await loadGenerationRecentTurns({
      representativeId: "representative-1",
      conversationId: "conversation-1",
      beforeMessageId: "message-current",
      limit: 6,
    });

    expect(mocks.message.findMany).toHaveBeenCalledWith({
      where: {
        conversationId: "conversation-1",
        episodeId: "episode-1",
        redactedAt: null,
        text: { not: null },
        createdAt: { lt: new Date("2026-08-04T10:05:00.000Z") },
        senderType: MessageSenderType.AUDIENCE,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 6,
      select: { id: true, senderType: true, text: true, createdAt: true },
    });
    expect(recentTurns).toEqual([
      {
        id: "message-second",
        direction: "inbound",
        messageText: "Second audience question",
        createdAt: "2026-08-04T10:01:00.000Z",
      },
      {
        id: "message-first",
        direction: "inbound",
        messageText: "First audience question",
        createdAt: "2026-08-04T10:00:00.000Z",
      },
    ]);
    expect(recentTurns.every((turn) => turn.direction === "inbound")).toBe(true);
    expect(mocks.generationRun.findMany).not.toHaveBeenCalled();
  });

  it("adds only real request state from the same bounded episode, never previous answer bodies", async () => {
    mocks.generationRun.findMany.mockResolvedValue([
      { inputMessageId: "message-second", status: "COMPLETED", contextSnapshot: { agentTrace: {
        runtime: "delegate-agent-v2", status: "completed", text: "revoked answer body" } } },
      { inputMessageId: "message-second", status: "FAILED", contextSnapshot: null },
      { inputMessageId: "message-first", status: "COMPLETED", contextSnapshot: { agentTrace: { runtime: "delegate-agent-v2", status: "waiting_user" } } },
    ]);
    const turns = await loadGenerationRecentTurns({ representativeId: "representative-1", conversationId: "conversation-1",
      beforeMessageId: "message-current", includeRequestState: true });
    expect(turns.find(t => t.id === "message-second")?.requestState).toBe("completed");
    expect(turns.find(t => t.id === "message-first")?.requestState).toBe("waiting_user");
    expect(JSON.stringify(turns)).not.toContain("revoked answer body");
    expect(mocks.generationRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      conversationId: "conversation-1", episodeId: "episode-1", conversation: { representativeId: "representative-1" },
      inputMessageId: { in: ["message-second", "message-first"] }, createdAt: { lt: new Date("2026-08-04T10:05:00.000Z") },
    } }));
  });

  it("does not invent success for a missing or legacy execution record", async () => {
    mocks.generationRun.findMany.mockResolvedValue([{ inputMessageId: "message-first", status: "COMPLETED", contextSnapshot: null }]);
    const turns = await loadGenerationRecentTurns({ representativeId: "representative-1", conversationId: "conversation-1", beforeMessageId: "current", includeRequestState: true });
    expect(turns.find(t => t.id === "message-first")?.requestState).toBe("answered");
    expect(turns.find(t => t.id === "message-second")?.requestState).toBe("unknown");
    mocks.representativeMemoryPolicy.findUnique.mockResolvedValue({ shortTermMemoryEnabled: false });
    mocks.generationRun.findMany.mockClear();
    expect(await loadGenerationRecentTurns({ representativeId: "representative-1", conversationId: "conversation-1", beforeMessageId: "current", includeRequestState: true })).toEqual([]);
    expect(mocks.generationRun.findMany).not.toHaveBeenCalled();
  });
  it("does not label canceled or failed delivery as complete just because model generation finished", async () => {
    mocks.generationRun.findMany.mockResolvedValue([
      { inputMessageId: "message-first", status: "CANCELED", contextSnapshot: { agentTrace: { runtime: "delegate-agent-v2", status: "completed" } } },
      { inputMessageId: "message-second", status: "FAILED", contextSnapshot: { agentTrace: { runtime: "delegate-agent-v2", status: "completed" } } },
    ]);
    const turns = await loadGenerationRecentTurns({ representativeId: "representative-1", conversationId: "conversation-1", beforeMessageId: "current", includeRequestState: true });
    expect(turns.find(t => t.id === "message-first")?.requestState).toBe("cancelled");
    expect(turns.find(t => t.id === "message-second")?.requestState).toBe("failed");
  });

  it("returns no prior turns when short-term memory is disabled", async () => {
    mocks.representativeMemoryPolicy.findUnique.mockResolvedValue({
      shortTermMemoryEnabled: false,
    });

    await expect(loadGenerationRecentTurns({
      representativeId: "representative-1",
      conversationId: "conversation-1",
      beforeMessageId: "message-current",
    })).resolves.toEqual([]);

    expect(mocks.message.findMany).not.toHaveBeenCalled();
  });

  it("fails closed when the current message has no episode", async () => {
    mocks.message.findUnique.mockResolvedValue({
      createdAt: new Date("2026-08-04T10:05:00.000Z"),
      episodeId: null,
    });

    await expect(loadGenerationRecentTurns({
      representativeId: "representative-1",
      conversationId: "conversation-1",
      beforeMessageId: "message-current",
    })).resolves.toEqual([]);

    expect(mocks.message.findMany).not.toHaveBeenCalled();
  });

  it('uses the revalidated task anchor and omits earlier weather/history topics',async()=>{
    const row=(id:string,text:string,minute:number)=>({id,text,senderType:MessageSenderType.AUDIENCE,createdAt:new Date(`2026-08-04T10:0${minute}:00Z`)});
    const anchor=row('fund','基金今天的行情如何',2);
    mocks.message.findMany.mockResolvedValue([row('value','就这只110011',4),row('parameter','110011',3),anchor,row('weather','深圳天气',1)]);
    mocks.generationRun.findFirst.mockResolvedValue({contextSnapshot:{agentTrace:{conversationFocus:{anchorMessageId:'fund'}}}});
    mocks.message.findFirst.mockResolvedValue(anchor);
    const result=await loadGenerationRecentTurns({representativeId:'rep',conversationId:'conversation-1',beforeMessageId:'current',focusCurrentTask:true});
    expect(result.map(r=>r.id)).toEqual(['fund','parameter','value']);
    expect(result[0]?.taskAnchor).toBe(true);
    expect(mocks.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:'fund',conversationId:'conversation-1',episodeId:'episode-1',senderType:'AUDIENCE',redactedAt:null})}));
  });
  it('does not restore a deleted or foreign focus reference and bounds legacy context',async()=>{
    mocks.generationRun.findFirst.mockResolvedValue({contextSnapshot:{agentTrace:{conversationFocus:{anchorMessageId:'foreign'}}}});
    mocks.message.findFirst.mockResolvedValue(null);
    mocks.message.findMany.mockResolvedValue([4,3,2,1].map(n=>({id:String(n),text:'context '+n,senderType:MessageSenderType.AUDIENCE,createdAt:new Date(`2026-08-04T10:0${n}:00Z`)})));
    const result=await loadGenerationRecentTurns({representativeId:'rep',conversationId:'conversation-1',beforeMessageId:'current',focusCurrentTask:true});
    expect(result.map(r=>r.id)).toEqual(['2','3','4']);expect(result.every(r=>!r.taskAnchor)).toBe(true);
  });
  it('does not load a focus reference when memory is disabled',async()=>{
    mocks.representativeMemoryPolicy.findUnique.mockResolvedValue({shortTermMemoryEnabled:false});
    expect(await loadGenerationRecentTurns({representativeId:'rep',conversationId:'conversation-1',beforeMessageId:'current',focusCurrentTask:true})).toEqual([]);
    expect(mocks.generationRun.findFirst).not.toHaveBeenCalled();
  });
  it('keeps a revalidated parameter source when a newer request supplies the outcome',async()=>{
    const target={id:'target',text:'易方达优质精选混合',senderType:MessageSenderType.AUDIENCE,createdAt:new Date('2026-08-04T10:00:00Z')};
    const anchor={id:'goal',text:'今天表现如何',senderType:MessageSenderType.AUDIENCE,createdAt:new Date('2026-08-04T10:03:00Z')};
    mocks.generationRun.findFirst.mockResolvedValue({contextSnapshot:{agentTrace:{conversationFocus:{anchorMessageId:'goal',parameterMessageId:'target'}}}});
    mocks.message.findFirst.mockResolvedValueOnce(anchor).mockResolvedValueOnce(target);
    mocks.message.findMany.mockResolvedValue([anchor,target]);
    const result=await loadGenerationRecentTurns({representativeId:'rep',conversationId:'conversation-1',beforeMessageId:'current',focusCurrentTask:true});
    expect(result.map(r=>r.id)).toEqual(['goal','target']);expect(result[0]?.taskAnchor).toBe(true);
  });
});
