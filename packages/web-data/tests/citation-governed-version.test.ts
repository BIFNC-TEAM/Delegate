import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authority: vi.fn() }));
vi.mock("../src/agent-context-authorization", () => ({ citationAuthorityInTransaction: mocks.authority }));
vi.mock("../src/conversation-platform", () => ({ fenceGenerationWorkLease: vi.fn(async () => undefined) }));
import { allocateEpisodeCitationSourceInTransaction } from "../src/citation-persistence";

describe("governed citation version identity (simulated authority and storage)", () => {
  it("deduplicates immutable versions rather than per-run use-item ids and assigns a new number to v2", async () => {
    let snapshot = {};
    const rows: Array<Record<string, any>> = [];
    mocks.authority.mockImplementation(async () => ({ scope: { runId: "run", episodeId: "episode", messageEpisodeId: "episode", sourceChannel: "web",
      representativeId: "rep", representativeVersionId: "published", conversationId: "conversation", contactId: "contact", audienceIdentityId: "audience" },
      snapshot, memory: [{ useRunId: "use", itemIds: ["item1", "item2", "item3"] }], remote: [] }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      memoryUseItem: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({ sourceKind: "CONTACT_MEMORY", contentHash: "a".repeat(64), publicKnowledgeProjection: null,
        memoryVersionId: where.id === "item3" ? "immutable-v2" : "immutable-v1" })) },
      episodeCitationSource: {
        findUnique: vi.fn(async ({ where }: { where: { episodeId_sourceKey: { sourceKey: string } } }) => rows.find(row => row.sourceKey === where.episodeId_sourceKey.sourceKey) ?? null),
        aggregate: vi.fn(async () => ({ _max: { ordinal: rows.length || null } })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `source-${rows.length + 1}`, ...data }; rows.push(row); return row; }),
      },
      generationRun: { update: vi.fn(async ({ data }: { data: { contextSnapshot: object } }) => { snapshot = data.contextSnapshot; }) },
    } as unknown as Prisma.TransactionClient;
    const allocate = (id: string) => allocateEpisodeCitationSourceInTransaction(tx, { runId: "run", outboxId: "outbox", leaseAttempt: 1, source: { id, title: "本人历史信息", channel: "knowledge" } });
    expect(await allocate("item1")).toBe("1");
    expect(await allocate("item2")).toBe("1");
    expect(await allocate("item3")).toBe("2");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.sourceKey).not.toBe(rows[1]!.sourceKey);
  });
});
