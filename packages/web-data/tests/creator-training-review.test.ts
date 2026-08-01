import { describe, expect, it } from "vitest";

import {
  evaluateCreatorTrainingDraftPayload,
  reviewCreatorTrainingSuggestion,
  rollbackCreatorTrainingVersion,
} from "../src/creator-training";

describe("creator training review and publish", () => {
  it("publishes an approved FAQ suggestion into KnowledgePack and stores a version", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.suggestions.push(buildSuggestion());

    const result = await reviewCreatorTrainingSuggestion(
      "lin",
      "suggestion-1",
      {
        action: "approve",
        reviewedBy: "owner-1",
        now: new Date("2026-07-04T12:30:00.000Z"),
      },
      client,
    );

    expect(result.suggestion).toMatchObject({
      id: "suggestion-1",
      status: "published",
      reviewedBy: "owner-1",
    });
    expect(client.knowledgePackRow?.faq).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^training_origin_[a-f0-9]{64}$/u),
        title: "Refund FAQ",
        kind: "faq",
        summary: "Refunds are available within seven days.",
      }),
    ]);
    expect(result.version).toMatchObject({
      suggestionId: "suggestion-1",
      status: "published",
      snapshotBefore: expect.objectContaining({ faq: [] }),
      snapshotAfter: expect.objectContaining({ faq: expect.any(Array) }),
      evaluationReport: expect.objectContaining({
        outcome: "passed",
        checks: expect.any(Array),
      }),
    });
  });

  it("rejects a suggestion without changing KnowledgePack", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.suggestions.push(buildSuggestion());

    const result = await reviewCreatorTrainingSuggestion(
      "lin",
      "suggestion-1",
      {
        action: "reject",
        reviewNote: "Not accurate enough.",
      },
      client,
    );

    expect(result.suggestion.status).toBe("rejected");
    expect(result.version).toBeNull();
    expect(client.knowledgePackRow?.faq).toEqual([]);
  });

  it("publishes creator-edited draft payload", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.suggestions.push(buildSuggestion());

    await reviewCreatorTrainingSuggestion(
      "lin",
      "suggestion-1",
      {
        action: "approve",
        editedDraftPayload: {
          kind: "faq",
          title: "Edited refund FAQ",
          summary: "Creator-edited answer wins.",
        },
      },
      client,
    );

    expect(client.suggestions[0]?.draftPayload).toEqual({
      kind: "faq",
      title: "Edited refund FAQ",
      summary: "Creator-edited answer wins.",
    });
    expect(client.knowledgePackRow?.faq).toEqual([
      expect.objectContaining({
        title: "Edited refund FAQ",
        summary: "Creator-edited answer wins.",
      }),
    ]);
  });

  it("requires an owner-authored answer before approving a knowledge gap", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.suggestions.push(
      buildSuggestion({
        suggestionType: "KNOWLEDGE_GAP",
        title: "Repeated refund question",
        draftPayload: {
          question: "What is the refund policy?",
          occurrenceCount: 3,
        },
      }),
    );

    await expect(
      reviewCreatorTrainingSuggestion(
        "lin",
        "suggestion-1",
        { action: "approve" },
        client,
      ),
    ).rejects.toThrow("Knowledge gap requires a creator-authored answer.");
    expect(client.suggestions[0]?.status).toBe("PENDING");
    expect(client.knowledgePackRow?.faq).toEqual([]);
    expect(client.versions).toHaveLength(0);
  });

  it("rejects the legacy knowledge-gap placeholder as an answer", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.suggestions.push(
      buildSuggestion({
        suggestionType: "KNOWLEDGE_GAP",
        draftPayload: {
          question: "What is the refund policy?",
          summary:
            "Needs a creator-approved answer for: What is the refund policy?",
        },
      }),
    );

    await expect(
      reviewCreatorTrainingSuggestion(
        "lin",
        "suggestion-1",
        {
          action: "approve",
          editedDraftPayload: {
            question: "What is the refund policy?",
            summary: "  Needs a creator-approved answer for: refunds  ",
          },
        },
        client,
      ),
    ).rejects.toThrow("Knowledge gap requires a creator-authored answer.");
    expect(client.knowledgePackRow?.faq).toEqual([]);
  });

  it("writes an owner-authored knowledge-gap answer into the FAQ draft", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.suggestions.push(
      buildSuggestion({
        suggestionType: "KNOWLEDGE_GAP",
        title: "Repeated refund question",
        draftPayload: {
          question: "What is the refund policy?",
          occurrenceCount: 3,
        },
      }),
    );

    await reviewCreatorTrainingSuggestion(
      "lin",
      "suggestion-1",
      {
        action: "approve",
        reviewedBy: "owner-1",
        editedDraftPayload: {
          kind: "faq",
          question: "What is the refund policy?",
          title: "What is the refund policy?",
          summary: "Customers may request a refund within seven days of purchase.",
          occurrenceCount: 3,
        },
      },
      client,
    );

    expect(client.knowledgePackRow?.faq).toEqual([
      expect.objectContaining({
        title: "What is the refund policy?",
        summary: "Customers may request a refund within seven days of purchase.",
      }),
    ]);
    expect(client.suggestions[0]).toMatchObject({
      status: "PUBLISHED",
      reviewedBy: "owner-1",
    });
  });

  it("publishes only the newest source successor and keeps one stable material id", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    const originKey = "source:source-1:material_update";
    client.sources.push(buildSource());
    client.suggestions.push(
      buildSuggestion({
        id: "source-suggestion-old",
        originKey,
        sourceId: "source-1",
        feedbackSignalId: null,
        suggestionType: "MATERIAL_UPDATE",
        status: "SUPERSEDED",
        draftPayload: {
          kind: "download",
          title: "Workshop upload",
          summary: "Outdated source summary.",
        },
      }),
      buildSuggestion({
        id: "source-suggestion-current",
        originKey,
        sourceId: "source-1",
        feedbackSignalId: null,
        suggestionType: "MATERIAL_UPDATE",
        draftPayload: {
          kind: "download",
          title: "Workshop upload",
          summary: "Current source summary.",
        },
      }),
    );
    client.knowledgePackRow!.materials = [
      {
        id: "training_source-suggestion-old",
        title: "Workshop upload",
        kind: "download",
        summary: "Previously published legacy summary.",
      },
    ];

    await reviewCreatorTrainingSuggestion(
      "lin",
      "source-suggestion-current",
      { action: "approve" },
      client,
    );
    await expect(
      reviewCreatorTrainingSuggestion(
        "lin",
        "source-suggestion-old",
        { action: "approve" },
        client,
      ),
    ).rejects.toThrow("Creator training suggestion is no longer pending.");
    const stableId = (
      client.knowledgePackRow!.materials[0] as { id: string }
    ).id;

    client.suggestions.push(
      buildSuggestion({
        id: "source-suggestion-next",
        originKey,
        sourceId: "source-1",
        feedbackSignalId: null,
        suggestionType: "MATERIAL_UPDATE",
        draftPayload: {
          kind: "download",
          title: "Workshop upload",
          summary: "Newest source summary.",
        },
      }),
    );
    await reviewCreatorTrainingSuggestion(
      "lin",
      "source-suggestion-next",
      { action: "approve" },
      client,
    );

    expect(client.knowledgePackRow?.materials).toEqual([
      expect.objectContaining({
        id: stableId,
        summary: "Newest source summary.",
      }),
    ]);
    expect(stableId).toMatch(/^training_origin_[a-f0-9]{64}$/u);
  });

  it("publishes only the newest unknown-question successor into one stable FAQ", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    const originKey = "unknown:what is the refund policy";
    client.suggestions.push(
      buildSuggestion({
        id: "unknown-suggestion-old",
        originKey,
        sourceId: null,
        feedbackSignalId: null,
        suggestionType: "KNOWLEDGE_GAP",
        status: "SUPERSEDED",
        draftPayload: {
          question: "What is the refund policy?",
          occurrenceCount: 2,
        },
      }),
      buildSuggestion({
        id: "unknown-suggestion-current",
        originKey,
        sourceId: null,
        feedbackSignalId: null,
        suggestionType: "KNOWLEDGE_GAP",
        draftPayload: {
          question: "What is the refund policy?",
          occurrenceCount: 3,
        },
      }),
    );

    await reviewCreatorTrainingSuggestion(
      "lin",
      "unknown-suggestion-current",
      {
        action: "approve",
        editedDraftPayload: {
          question: "What is the refund policy?",
          summary: "Refunds are available within seven days.",
        },
      },
      client,
    );
    await expect(
      reviewCreatorTrainingSuggestion(
        "lin",
        "unknown-suggestion-old",
        {
          action: "approve",
          editedDraftPayload: {
            question: "What is the refund policy?",
            summary: "An obsolete answer.",
          },
        },
        client,
      ),
    ).rejects.toThrow("Creator training suggestion is no longer pending.");
    const stableId = (client.knowledgePackRow!.faq[0] as { id: string }).id;

    client.suggestions.push(
      buildSuggestion({
        id: "unknown-suggestion-next",
        originKey,
        sourceId: null,
        feedbackSignalId: null,
        suggestionType: "KNOWLEDGE_GAP",
        draftPayload: {
          question: "What is the refund policy?",
          occurrenceCount: 4,
        },
      }),
    );
    await reviewCreatorTrainingSuggestion(
      "lin",
      "unknown-suggestion-next",
      {
        action: "approve",
        editedDraftPayload: {
          question: "What is the refund policy?",
          summary: "Refunds are now available within nine days.",
        },
      },
      client,
    );

    expect(client.knowledgePackRow?.faq).toEqual([
      expect.objectContaining({
        id: stableId,
        summary: "Refunds are now available within nine days.",
      }),
    ]);
    expect(stableId).toMatch(/^training_origin_[a-f0-9]{64}$/u);
  });

  it("publishes uploaded material suggestions into KnowledgePack materials", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.sources.push(buildSource());
    client.suggestions.push(
      buildSuggestion({
        sourceId: "source-1",
        suggestionType: "MATERIAL_UPDATE",
        title: "Workshop upload",
        draftPayload: {
          kind: "download",
          title: "Workshop upload",
          summary: "The workshop refund window is seven days.",
        },
      }),
    );

    const result = await reviewCreatorTrainingSuggestion(
      "lin",
      "suggestion-1",
      {
        action: "approve",
        reviewedBy: "owner-1",
      },
      client,
    );

    expect(result.suggestion.status).toBe("published");
    expect(client.sources[0]?.status).toBe("ACTIVE");
    expect(client.knowledgePackRow?.materials).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^training_origin_[a-f0-9]{64}$/u),
        title: "Workshop upload",
        kind: "download",
        summary: "The workshop refund window is seven days.",
      }),
    ]);
  });

  it("publishes uploaded material summaries without upload metadata preambles", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.sources.push(buildSource());
    client.suggestions.push(
      buildSuggestion({
        sourceId: "source-1",
        suggestionType: "MATERIAL_UPDATE",
        title: "DOCX upload",
        draftPayload: {
          kind: "download",
          title: "DOCX upload",
          summary:
            "Uploaded file: training.docx MIME type: application/vnd.openxmlformats-officedocument.wordprocessingml.document DOCX 训练资料：专属暗号是 CINNAMON-638。",
        },
      }),
    );

    await reviewCreatorTrainingSuggestion("lin", "suggestion-1", { action: "approve" }, client);

    expect(client.knowledgePackRow?.materials).toEqual([
      expect.objectContaining({
        summary: "DOCX 训练资料：专属暗号是 CINNAMON-638。",
      }),
    ]);
  });

  it("fails evaluation for guaranteed outcome claims", () => {
    expect(
      evaluateCreatorTrainingDraftPayload({
        kind: "faq",
        title: "Revenue promise",
        summary: "This program has guaranteed revenue for every buyer.",
      }),
    ).toMatchObject({
      outcome: "failed",
    });
  });

  it("blocks publishing when release evaluation fails", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.suggestions.push(
      buildSuggestion({
        draftPayload: {
          kind: "faq",
          title: "Revenue promise",
          summary: "This program has guaranteed revenue for every buyer.",
        },
      }),
    );

    await expect(
      reviewCreatorTrainingSuggestion("lin", "suggestion-1", { action: "approve" }, client),
    ).rejects.toThrow("Creator training evaluation failed.");
    expect(client.versions).toHaveLength(0);
    expect(client.knowledgePackRow?.faq).toEqual([]);
  });

  it("reviews only pending suggestions", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.suggestions.push(buildSuggestion({ status: "PUBLISHED" }));

    await expect(
      reviewCreatorTrainingSuggestion("lin", "suggestion-1", { action: "approve" }, client),
    ).rejects.toThrow("Creator training suggestion is no longer pending.");
    expect(client.versions).toHaveLength(0);
  });

  it("takes a parameterized representative advisory lock before approving", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.suggestions.push(buildSuggestion());
    const events: string[] = [];
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const findFirst = client.creatorTrainingSuggestion.findFirst;
    client.creatorTrainingSuggestion.findFirst = async (args: any) => {
      events.push("suggestion-read");
      return findFirst(args);
    };
    client.$queryRaw = async (query, ...values) => {
      events.push("advisory-lock");
      queries.push({
        text: Array.from(query).join("$parameter"),
        values,
      });
      return [] as never;
    };

    await reviewCreatorTrainingSuggestion(
      "lin",
      "suggestion-1",
      { action: "approve" },
      client,
    );

    expect(events.slice(0, 2)).toEqual(["advisory-lock", "suggestion-read"]);
    expect(queries).toEqual([
      {
        text: expect.stringContaining(
          "pg_advisory_xact_lock(hashtextextended($parameter, 0))",
        ),
        values: ["delegate:knowledge-pack:rep-1"],
      },
    ]);
    expect(queries[0]?.text).toContain("WITH lock_acquired AS MATERIALIZED");
    expect(queries[0]?.text).toContain("SELECT 1::int AS acquired");
    expect(queries[0]?.text).toContain("FROM lock_acquired");
  });

  it("rolls back a published version to its before snapshot", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.knowledgePackRow = {
      representativeId: "rep-1",
      identitySummary: "After publish",
      faq: [{ id: "new-faq" }],
      materials: [],
      policies: [],
    };
    client.versions.push({
      id: "version-1",
      representativeId: "rep-1",
      revisionNumber: 1,
      suggestionId: "suggestion-1",
      status: "PUBLISHED",
      title: "Refund FAQ",
      snapshotBefore: {
        identitySummary: "Before publish",
        faq: [{ id: "old-faq" }],
        materials: [],
        policies: [],
      },
      snapshotAfter: {
        identitySummary: "After publish",
        faq: [{ id: "new-faq" }],
        materials: [],
        policies: [],
      },
      evaluationReport: { outcome: "passed" },
      publishedBy: "owner-1",
      publishedAt: new Date("2026-07-04T12:30:00.000Z"),
      rolledBackBy: null,
      rolledBackAt: null,
      createdAt: new Date("2026-07-04T12:30:00.000Z"),
    });

    const version = await rollbackCreatorTrainingVersion(
      "lin",
      "version-1",
      {
        now: new Date("2026-07-04T13:00:00.000Z"),
        rolledBackBy: "owner-rollback",
      },
      client,
    );

    expect(version).toMatchObject({
      id: "version-1",
      status: "rolled_back",
      rolledBackBy: "owner-rollback",
      rolledBackAt: "2026-07-04T13:00:00.000Z",
    });
    expect(client.knowledgePackRow).toMatchObject({
      identitySummary: "Before publish",
      faq: [{ id: "old-faq" }],
    });
  });

  it("takes the representative advisory lock before reading a rollback version", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.knowledgePackRow = {
      representativeId: "rep-1",
      identitySummary: "After publish",
      faq: [{ id: "new-faq" }],
      materials: [],
      policies: [],
    };
    client.versions.push(buildVersion());
    const events: string[] = [];
    const findFirst = client.creatorTrainingVersion.findFirst;
    client.creatorTrainingVersion.findFirst = async (args: any) => {
      events.push("version-read");
      return findFirst(args);
    };
    client.$queryRaw = async () => {
      events.push("advisory-lock");
      return [] as never;
    };

    await rollbackCreatorTrainingVersion("lin", "version-1", {}, client);

    expect(events.slice(0, 2)).toEqual(["advisory-lock", "version-read"]);
  });

  it("does not let an older training version overwrite newer draft changes", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.knowledgePackRow = {
      representativeId: "rep-1",
      identitySummary: "Newest draft",
      faq: [{ id: "faq-2" }],
      materials: [],
      policies: [],
    };
    client.versions.push(
      buildVersion({
        id: "version-1",
        revisionNumber: 1,
        publishedAt: new Date("2026-07-04T12:00:00.000Z"),
        snapshotAfter: {
          identitySummary: "Older draft",
          faq: [{ id: "faq-1" }],
          materials: [],
          policies: [],
        },
      }),
      buildVersion({
        id: "version-2",
        revisionNumber: 2,
        publishedAt: new Date("2026-07-04T13:00:00.000Z"),
        snapshotAfter: {
          identitySummary: "Newest draft",
          faq: [{ id: "faq-2" }],
          materials: [],
          policies: [],
        },
      }),
    );

    await expect(
      rollbackCreatorTrainingVersion("lin", "version-1", {}, client),
    ).rejects.toThrow("Only the latest applied creator training version can be rolled back.");
    expect(client.knowledgePackRow.identitySummary).toBe("Newest draft");
  });

  it("refuses rollback when multiple published versions match the current snapshot", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    const currentSnapshot = {
      identitySummary: "Ambiguous current draft",
      faq: [{ id: "current-faq" }],
      materials: [],
      policies: [],
    };
    client.knowledgePackRow = {
      representativeId: "rep-1",
      ...currentSnapshot,
    };
    client.versions.push(
      buildVersion({
        id: "version-1",
        revisionNumber: 1,
        snapshotBefore: {
          identitySummary: "First possible predecessor",
          faq: [],
          materials: [],
          policies: [],
        },
        snapshotAfter: currentSnapshot,
      }),
      buildVersion({
        id: "version-2",
        revisionNumber: 2,
        snapshotBefore: {
          identitySummary: "Second possible predecessor",
          faq: [{ id: "different-history" }],
          materials: [],
          policies: [],
        },
        snapshotAfter: currentSnapshot,
      }),
    );

    await expect(
      rollbackCreatorTrainingVersion("lin", "version-2", {}, client),
    ).rejects.toThrow("Creator training history is ambiguous");
    expect(client.knowledgePackRow).toMatchObject(currentSnapshot);
    expect(client.versions.map((version) => version.status)).toEqual([
      "PUBLISHED",
      "PUBLISHED",
    ]);
  });

  it("does not roll back after the knowledge draft changed outside that version", async () => {
    const client = new FakeCreatorTrainingReviewClient();
    client.knowledgePackRow = {
      representativeId: "rep-1",
      identitySummary: "Manually edited after training",
      faq: [{ id: "manual-faq" }],
      materials: [],
      policies: [],
    };
    client.versions.push(buildVersion({ id: "version-1" }));

    await expect(
      rollbackCreatorTrainingVersion("lin", "version-1", {}, client),
    ).rejects.toThrow("Knowledge draft changed after this creator training version.");
    expect(client.versions[0]?.status).toBe("PUBLISHED");
  });
});

type SuggestionRow = {
  id: string;
  representativeId: string;
  originKey: string;
  originRevision: number;
  sourceId: string | null;
  feedbackSignalId: string | null;
  suggestionType: string;
  status: string;
  title: string;
  rationale: string;
  draftPayload: unknown;
  dedupeKey: string;
  riskLevel: string;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SourceRow = {
  id: string;
  representativeId: string;
  kind: string;
  status: string;
  title: string;
  locator: string | null;
  contentText: string | null;
  metadata: unknown;
  lastSyncedAt: Date | null;
  errorReason: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type KnowledgePackRow = {
  representativeId: string;
  identitySummary: string;
  faq: unknown[];
  materials: unknown[];
  policies: unknown[];
};

type VersionRow = {
  id: string;
  representativeId: string;
  revisionNumber: number;
  suggestionId: string | null;
  status: string;
  title: string;
  snapshotBefore: unknown;
  snapshotAfter: unknown;
  evaluationReport: unknown;
  publishedBy: string | null;
  publishedAt: Date;
  rolledBackBy: string | null;
  rolledBackAt: Date | null;
  createdAt: Date;
};

class FakeCreatorTrainingReviewClient {
  representatives = [{ id: "rep-1", slug: "lin" }];
  sources: SourceRow[] = [];
  suggestions: SuggestionRow[] = [];
  knowledgePackRow: KnowledgePackRow | null = {
    representativeId: "rep-1",
    identitySummary: "Lin is a creator.",
    faq: [],
    materials: [],
    policies: [],
  };
  versions: VersionRow[] = [];
  $queryRaw?: <T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;

  $transaction = async (callback: any) => callback(this);

  representative = {
    findUnique: async (args: any) =>
      this.representatives.find((rep) => rep.slug === args.where.slug) ?? null,
  };

  creatorTrainingSource = {
    update: async (args: any) => {
      const source = this.sources.find((item) => item.id === args.where.id);
      if (!source) {
        throw new Error("source not found");
      }
      Object.assign(source, args.data, { updatedAt: new Date("2026-07-04T12:30:00.000Z") });
      return source;
    },
  };

  creatorTrainingSuggestion = {
    findFirst: async (args: any) =>
      this.suggestions.find(
        (suggestion) =>
          suggestion.id === args.where.id &&
          suggestion.representativeId === args.where.representativeId,
      ) ?? null,
    findMany: async (args: any) =>
      this.suggestions
        .filter(
          (suggestion) =>
            suggestion.representativeId === args.where.representativeId &&
            suggestion.originKey === args.where.originKey,
        )
        .map((suggestion) => ({
          id: suggestion.id,
          draftPayload: suggestion.draftPayload,
        })),
    updateMany: async (args: any) => {
      const suggestion = this.suggestions.find(
        (item) =>
          item.id === args.where.id &&
          item.representativeId === args.where.representativeId &&
          item.status === args.where.status,
      );
      if (!suggestion) {
        return { count: 0 };
      }
      Object.assign(suggestion, args.data, {
        updatedAt: new Date("2026-07-04T12:30:00.000Z"),
      });
      return { count: 1 };
    },
    update: async (args: any) => {
      const suggestion = this.suggestions.find((item) => item.id === args.where.id);
      if (!suggestion) {
        throw new Error("suggestion not found");
      }
      Object.assign(suggestion, args.data, { updatedAt: new Date("2026-07-04T12:30:00.000Z") });
      return suggestion;
    },
  };

  knowledgePack = {
    findUnique: async (args: any) =>
      this.knowledgePackRow?.representativeId === args.where.representativeId
        ? this.knowledgePackRow
        : null,
    upsert: async (args: any) => {
      const row: KnowledgePackRow = {
        representativeId: args.where.representativeId,
        ...(this.knowledgePackRow ? args.update : args.create),
      };
      this.knowledgePackRow = row;
      return row;
    },
  };

  creatorTrainingVersion = {
    findMany: async (args: any) =>
      this.versions.filter(
        (version) =>
          version.representativeId === args.where.representativeId &&
          (!args.where.status || version.status === args.where.status),
      ),
    create: async (args: any) => {
      const now = new Date("2026-07-04T12:30:00.000Z");
      const version: VersionRow = {
        id: `version-${this.versions.length + 1}`,
        representativeId: args.data.representativeId,
        revisionNumber: args.data.revisionNumber,
        suggestionId: args.data.suggestionId ?? null,
        status: "PUBLISHED",
        title: args.data.title,
        snapshotBefore: args.data.snapshotBefore,
        snapshotAfter: args.data.snapshotAfter,
        evaluationReport: args.data.evaluationReport ?? null,
        publishedBy: args.data.publishedBy ?? null,
        publishedAt: now,
        rolledBackBy: null,
        rolledBackAt: null,
        createdAt: now,
      };
      this.versions.push(version);
      return version;
    },
    findFirst: async (args: any) => {
      const matches = this.versions
        .filter(
          (version) =>
            (!args.where.id || version.id === args.where.id) &&
            version.representativeId === args.where.representativeId &&
            (!args.where.status || version.status === args.where.status),
        )
        .sort((left, right) => right.revisionNumber - left.revisionNumber);
      return matches[0] ?? null;
    },
    update: async (args: any) => {
      const version = this.versions.find((item) => item.id === args.where.id);
      if (!version) {
        throw new Error("version not found");
      }
      Object.assign(version, args.data);
      return version;
    },
  };
}

function buildSource(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "source-1",
    representativeId: "rep-1",
    kind: "TEXT",
    status: "DRAFT",
    title: "Workshop upload",
    locator: "upload:workshop.txt",
    contentText: "The workshop refund window is seven days.",
    metadata: null,
    lastSyncedAt: null,
    errorReason: null,
    createdBy: "owner-1",
    createdAt: new Date("2026-07-04T12:00:00.000Z"),
    updatedAt: new Date("2026-07-04T12:00:00.000Z"),
    ...overrides,
  };
}

function buildSuggestion(overrides: Partial<SuggestionRow> = {}): SuggestionRow {
  return {
    id: "suggestion-1",
    representativeId: "rep-1",
    originKey: "feedback:feedback-1:faq_update",
    originRevision: 1,
    sourceId: null,
    feedbackSignalId: "feedback-1",
    suggestionType: "FAQ_UPDATE",
    status: "PENDING",
    title: "Refund FAQ",
    rationale: "Creator corrected a public answer.",
    draftPayload: {
      kind: "faq",
      title: "Refund FAQ",
      summary: "Refunds are available within seven days.",
    },
    dedupeKey: "feedback:feedback-1:faq_update",
    riskLevel: "medium",
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    createdAt: new Date("2026-07-04T12:00:00.000Z"),
    updatedAt: new Date("2026-07-04T12:00:00.000Z"),
    ...overrides,
  };
}

function buildVersion(overrides: Partial<VersionRow> = {}): VersionRow {
  const publishedAt = overrides.publishedAt ?? new Date("2026-07-04T12:30:00.000Z");
  return {
    id: "version-1",
    representativeId: "rep-1",
    revisionNumber: 1,
    suggestionId: "suggestion-1",
    status: "PUBLISHED",
    title: "Refund FAQ",
    snapshotBefore: {
      identitySummary: "Before publish",
      faq: [],
      materials: [],
      policies: [],
    },
    snapshotAfter: {
      identitySummary: "After publish",
      faq: [{ id: "new-faq" }],
      materials: [],
      policies: [],
    },
    evaluationReport: { outcome: "passed" },
    publishedBy: "owner-1",
    publishedAt,
    rolledBackBy: null,
    rolledBackAt: null,
    createdAt: publishedAt,
    ...overrides,
  };
}
