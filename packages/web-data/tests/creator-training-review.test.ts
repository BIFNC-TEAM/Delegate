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
        evaluationReport: { outcome: "passed" },
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
        id: "training_suggestion-1",
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
      evaluationReport: { outcome: "passed" },
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
        id: "training_suggestion-1",
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
      rolledBackAt: null,
      createdAt: new Date("2026-07-04T12:30:00.000Z"),
    });

    const version = await rollbackCreatorTrainingVersion(
      "lin",
      "version-1",
      { now: new Date("2026-07-04T13:00:00.000Z") },
      client,
    );

    expect(version).toMatchObject({
      id: "version-1",
      status: "rolled_back",
      rolledBackAt: "2026-07-04T13:00:00.000Z",
    });
    expect(client.knowledgePackRow).toMatchObject({
      identitySummary: "Before publish",
      faq: [{ id: "old-faq" }],
    });
  });
});

type SuggestionRow = {
  id: string;
  representativeId: string;
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
  suggestionId: string | null;
  status: string;
  title: string;
  snapshotBefore: unknown;
  snapshotAfter: unknown;
  evaluationReport: unknown;
  publishedBy: string | null;
  publishedAt: Date;
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
    create: async (args: any) => {
      const now = new Date("2026-07-04T12:30:00.000Z");
      const version: VersionRow = {
        id: `version-${this.versions.length + 1}`,
        representativeId: args.data.representativeId,
        suggestionId: args.data.suggestionId ?? null,
        status: "PUBLISHED",
        title: args.data.title,
        snapshotBefore: args.data.snapshotBefore,
        snapshotAfter: args.data.snapshotAfter,
        evaluationReport: args.data.evaluationReport ?? null,
        publishedBy: args.data.publishedBy ?? null,
        publishedAt: now,
        rolledBackAt: null,
        createdAt: now,
      };
      this.versions.push(version);
      return version;
    },
    findFirst: async (args: any) =>
      this.versions.find(
        (version) =>
          version.id === args.where.id &&
          version.representativeId === args.where.representativeId,
      ) ?? null,
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
