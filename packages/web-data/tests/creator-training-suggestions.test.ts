import { describe, expect, it } from "vitest";

import {
  buildCreatorTrainingSuggestions,
  listCreatorTrainingSuggestions,
} from "../src/creator-training";

describe("creator training suggestion engine", () => {
  it("builds deterministic suggestions from creator feedback", async () => {
    const client = new FakeCreatorTrainingSuggestionClient();
    client.feedbackSignals.push(
      buildFeedback({
        id: "feedback-correction",
        signalType: "CORRECTION",
        publicSafe: true,
        note: "Refund FAQ",
        suggestedText: "Refunds are available within seven days.",
      }),
      buildFeedback({
        id: "feedback-private",
        signalType: "CORRECTION",
        publicSafe: false,
        suggestedText: "This should not become public.",
      }),
      buildFeedback({
        id: "feedback-tone",
        signalType: "DO_NOT_SAY",
        publicSafe: true,
        note: "Never promise guaranteed revenue.",
      }),
      buildFeedback({
        id: "feedback-private-tone",
        signalType: "DO_NOT_SAY",
        publicSafe: false,
        note: "Private owner-only wording.",
      }),
    );

    const suggestions = await buildCreatorTrainingSuggestions("lin", {}, client);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          feedbackSignalId: "feedback-correction",
          suggestionType: "faq_update",
          status: "pending",
        }),
        expect.objectContaining({
          feedbackSignalId: "feedback-tone",
          suggestionType: "tone_rule",
          riskLevel: "high",
        }),
      ]),
    );
    expect(suggestions.some((item) => item.feedbackSignalId === "feedback-private")).toBe(false);
    expect(
      suggestions.some((item) => item.feedbackSignalId === "feedback-private-tone"),
    ).toBe(false);
  });

  it("builds one deduped knowledge gap from repeated unknown questions", async () => {
    const client = new FakeCreatorTrainingSuggestionClient();
    client.unknownTurns.push(
      buildUnknownTurn("What is your refund policy?"),
      buildUnknownTurn(" what is your refund policy "),
      buildUnknownTurn("Do not repeat me only once"),
    );

    const first = await buildCreatorTrainingSuggestions("lin", {}, client);
    const second = await buildCreatorTrainingSuggestions("lin", {}, client);
    const listed = await listCreatorTrainingSuggestions("lin", { status: "pending" }, client);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      suggestionType: "knowledge_gap",
      dedupeKey: expect.stringMatching(
        /^unknown:what is your refund policy:[a-f0-9]{16}$/u,
      ),
    });
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(listed).toHaveLength(1);
  });

  it.each(["PENDING", "REJECTED", "PUBLISHED"] as const)(
    "creates a successor instead of rewriting a %s source suggestion",
    async (status) => {
      const client = new FakeCreatorTrainingSuggestionClient();
      client.sources.push(
        buildSource({
          id: `source-${status.toLowerCase()}`,
          contentText: "The original owner-visible source content.",
        }),
      );

      const [ownerVisible] = await buildCreatorTrainingSuggestions("lin", {}, client);
      const originalPayload = structuredClone(ownerVisible?.draftPayload);
      client.suggestions[0]!.status = status;
      client.sources[0]!.contentText =
        "Background organization discovered materially different content.";
      const [successor] = await buildCreatorTrainingSuggestions("lin", {}, client);

      expect(successor).toMatchObject({
        status: "pending",
        draftPayload: expect.objectContaining({
          summary: "Background organization discovered materially different content.",
        }),
      });
      expect(successor?.id).not.toBe(ownerVisible?.id);
      expect(successor?.dedupeKey).not.toBe(ownerVisible?.dedupeKey);
      expect(client.suggestions).toHaveLength(2);
      expect(client.suggestions[0]).toMatchObject({
        id: ownerVisible?.id,
        originKey: successor?.originKey,
        status: status === "PENDING" ? "SUPERSEDED" : status,
        draftPayload: originalPayload,
      });
      expect(
        client.suggestions.filter(
          (suggestion) =>
            suggestion.originKey === successor?.originKey &&
            suggestion.status === "PENDING",
        ),
      ).toHaveLength(1);
    },
  );

  it("keeps a source suggestion idempotent when normalized content is unchanged", async () => {
    const client = new FakeCreatorTrainingSuggestionClient();
    client.sources.push(
      buildSource({
        id: "source-idempotent",
        contentText: "Stable source content.",
      }),
    );

    const [first] = await buildCreatorTrainingSuggestions("lin", {}, client);
    client.sources[0]!.contentText = "  Stable   source content.  ";
    const [second] = await buildCreatorTrainingSuggestions("lin", {}, client);

    expect(second?.id).toBe(first?.id);
    expect(client.suggestions).toHaveLength(1);
  });

  it("creates a new immutable generation when source evidence changes A to B to A", async () => {
    const client = new FakeCreatorTrainingSuggestionClient();
    client.sources.push(
      buildSource({
        id: "source-reverted",
        contentText: "Source evidence A.",
      }),
    );

    const [firstA] = await buildCreatorTrainingSuggestions("lin", {}, client);
    client.sources[0]!.contentText = "Source evidence B.";
    const [candidateB] = await buildCreatorTrainingSuggestions("lin", {}, client);
    client.sources[0]!.contentText = "Source evidence A.";
    const [secondA] = await buildCreatorTrainingSuggestions("lin", {}, client);

    expect(secondA).toMatchObject({
      status: "pending",
      draftPayload: firstA?.draftPayload,
      originRevision: 3,
    });
    expect(secondA?.id).not.toBe(firstA?.id);
    expect(secondA?.id).not.toBe(candidateB?.id);
    expect(candidateB?.id).not.toBe(firstA?.id);
    expect(
      client.suggestions.filter(
        (suggestion) =>
          suggestion.originKey === firstA?.originKey &&
          suggestion.status === "PENDING",
      ),
    ).toEqual([
      expect.objectContaining({
        id: secondA?.id,
      }),
    ]);
    expect(client.suggestions.find((suggestion) => suggestion.id === firstA?.id)?.status)
      .toBe("SUPERSEDED");
    expect(client.suggestions.find((suggestion) => suggestion.id === candidateB?.id)?.status)
      .toBe("SUPERSEDED");
  });

  it("creates one new pending generation when published evidence changes A to B to A", async () => {
    const client = new FakeCreatorTrainingSuggestionClient();
    client.sources.push(
      buildSource({
        id: "source-published-reverted",
        contentText: "Published source evidence A.",
      }),
    );

    const [firstA] = await buildCreatorTrainingSuggestions("lin", {}, client);
    client.suggestions[0]!.status = "PUBLISHED";
    client.sources[0]!.contentText = "Published source evidence B.";
    const [publishedB] = await buildCreatorTrainingSuggestions("lin", {}, client);
    client.suggestions.find((suggestion) => suggestion.id === publishedB?.id)!.status = "PUBLISHED";
    client.sources[0]!.contentText = "Published source evidence A.";

    const [revertedA] = await buildCreatorTrainingSuggestions("lin", {}, client);
    const [idempotentA] = await buildCreatorTrainingSuggestions("lin", {}, client);

    expect(revertedA).toMatchObject({
      status: "pending",
      originKey: firstA?.originKey,
      originRevision: 3,
      dedupeKey: firstA?.dedupeKey,
      draftPayload: firstA?.draftPayload,
    });
    expect(revertedA?.id).not.toBe(firstA?.id);
    expect(revertedA?.id).not.toBe(publishedB?.id);
    expect(idempotentA?.id).toBe(revertedA?.id);
    expect(client.suggestions).toHaveLength(3);
  });

  it("does not re-propose content restored by rolling back a later generation", async () => {
    const client = new FakeCreatorTrainingSuggestionClient();
    client.sources.push(
      buildSource({
        id: "source-rollback-restored",
        contentText: "Restored source evidence A.",
      }),
    );

    const [firstA] = await buildCreatorTrainingSuggestions("lin", {}, client);
    if (!firstA) throw new Error("Expected the first A suggestion.");
    client.suggestions[0]!.status = "PUBLISHED";
    client.versions.push({
      representativeId: "rep-1",
      revisionNumber: 1,
      suggestionId: firstA.id,
      status: "PUBLISHED",
    });

    client.sources[0]!.contentText = "Later source evidence B.";
    const [publishedB] = await buildCreatorTrainingSuggestions("lin", {}, client);
    if (!publishedB) throw new Error("Expected the B suggestion.");
    client.suggestions.find((suggestion) => suggestion.id === publishedB.id)!.status = "PUBLISHED";
    client.versions.push({
      representativeId: "rep-1",
      revisionNumber: 2,
      suggestionId: publishedB.id,
      status: "ROLLED_BACK",
    });

    client.sources[0]!.contentText = "Restored source evidence A.";
    const [restoredA] = await buildCreatorTrainingSuggestions("lin", {}, client);

    expect(restoredA).toMatchObject({
      id: firstA.id,
      status: "published",
      originRevision: 1,
    });
    expect(client.suggestions).toHaveLength(2);
    expect(client.suggestions.some((suggestion) => suggestion.status === "PENDING")).toBe(false);
  });

  it("creates a knowledge-gap successor when its evidence set changes", async () => {
    const client = new FakeCreatorTrainingSuggestionClient();
    client.unknownTurns.push(
      buildUnknownTurn("What is your refund policy?", {
        conversationId: "conversation-1",
        createdAt: new Date("2026-07-04T12:00:00.000Z"),
      }),
      buildUnknownTurn("what is your refund policy", {
        conversationId: "conversation-2",
        createdAt: new Date("2026-07-04T12:01:00.000Z"),
      }),
    );

    const [first] = await buildCreatorTrainingSuggestions("lin", {}, client);
    client.unknownTurns.push(
      buildUnknownTurn("What is your refund policy?", {
        conversationId: "conversation-3",
        createdAt: new Date("2026-07-04T12:02:00.000Z"),
      }),
    );
    const [successor] = await buildCreatorTrainingSuggestions("lin", {}, client);

    expect(successor?.id).not.toBe(first?.id);
    expect(successor?.dedupeKey).not.toBe(first?.dedupeKey);
    expect(successor?.originKey).toBe(first?.originKey);
    expect(successor?.draftPayload).toMatchObject({ occurrenceCount: 3 });
    expect(client.suggestions).toHaveLength(2);
    expect(client.suggestions[0]?.status).toBe("SUPERSEDED");
  });

  it("creates a feedback successor without rewriting the reviewed suggestion", async () => {
    const client = new FakeCreatorTrainingSuggestionClient();
    client.feedbackSignals.push(
      buildFeedback({
        id: "feedback-reviewed",
        note: "Original reviewed wording",
        suggestedText: "The approved answer remains immutable.",
      }),
    );

    const [reviewed] = await buildCreatorTrainingSuggestions("lin", {}, client);
    const persisted = client.suggestions[0]!;
    persisted.status = "PUBLISHED";
    persisted.reviewedAt = new Date("2026-07-04T12:30:00.000Z");
    persisted.reviewedBy = "owner-1";
    client.feedbackSignals[0]!.suggestedText = "A later organizer answer.";

    const [organizedAgain] = await buildCreatorTrainingSuggestions("lin", {}, client);

    expect(organizedAgain).toMatchObject({
      status: "pending",
      originKey: reviewed?.originKey,
      draftPayload: expect.objectContaining({
        summary: "A later organizer answer.",
      }),
    });
    expect(organizedAgain?.id).not.toBe(reviewed?.id);
    expect(client.suggestions[0]).toMatchObject({
      id: reviewed?.id,
      status: "PUBLISHED",
      draftPayload: reviewed?.draftPayload,
      reviewedBy: "owner-1",
    });
  });

  it("builds publishable material suggestions from uploaded sources", async () => {
    const client = new FakeCreatorTrainingSuggestionClient();
    client.sources.push(
      buildSource({
        id: "source-upload-1",
        title: "Workshop FAQ upload",
        locator: "upload:workshop.md",
        contentText: "The workshop refund window is seven days.",
      }),
    );

    const suggestions = await buildCreatorTrainingSuggestions("lin", {}, client);

    expect(suggestions).toEqual([
      expect.objectContaining({
        sourceId: "source-upload-1",
        suggestionType: "material_update",
        dedupeKey: expect.stringMatching(
          /^source:source-upload-1:material_update:[a-f0-9]{16}$/u,
        ),
        draftPayload: expect.objectContaining({
          kind: "download",
          title: "Workshop FAQ upload",
          summary: "The workshop refund window is seven days.",
        }),
      }),
    ]);
  });

  it("strips upload metadata before drafting publishable source summaries", async () => {
    const client = new FakeCreatorTrainingSuggestionClient();
    client.sources.push(
      buildSource({
        id: "source-upload-2",
        title: "DOCX upload",
        locator: "upload:training.docx",
        contentText: [
          "Uploaded file: training.docx",
          "MIME type: application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Extracted text:",
          "DOCX 训练资料：专属暗号是 PINEAPPLE-427，退款窗口是 9 天。",
        ].join("\n"),
      }),
    );

    const suggestions = await buildCreatorTrainingSuggestions("lin", {}, client);

    expect(suggestions[0]).toMatchObject({
      sourceId: "source-upload-2",
      draftPayload: expect.objectContaining({
        summary: "DOCX 训练资料：专属暗号是 PINEAPPLE-427，退款窗口是 9 天。",
      }),
    });
  });

  it("keeps suggestions isolated per representative", async () => {
    const client = new FakeCreatorTrainingSuggestionClient();
    client.feedbackSignals.push(
      buildFeedback({
        id: "feedback-lin",
        representativeId: "rep-1",
        signalType: "DO_NOT_SAY",
        note: "Lin only",
      }),
      buildFeedback({
        id: "feedback-ada",
        representativeId: "rep-2",
        signalType: "DO_NOT_SAY",
        note: "Ada only",
      }),
    );

    const suggestions = await buildCreatorTrainingSuggestions("lin", {}, client);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.feedbackSignalId).toBe("feedback-lin");
  });
});

type FeedbackRow = {
  id: string;
  representativeId: string;
  contactId: string | null;
  conversationId: string | null;
  turnId: string | null;
  signalType: string;
  status: string;
  publicSafe: boolean;
  note: string | null;
  suggestedText: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type UnknownTurnRow = {
  messageText: string;
  conversationId: string;
  createdAt: Date;
  representativeId: string;
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

type VersionRow = {
  representativeId: string;
  revisionNumber: number;
  suggestionId: string;
  status: "PUBLISHED" | "ROLLED_BACK";
};

class FakeCreatorTrainingSuggestionClient {
  representatives = [
    { id: "rep-1", slug: "lin" },
    { id: "rep-2", slug: "ada" },
  ];
  sources: SourceRow[] = [];
  feedbackSignals: FeedbackRow[] = [];
  unknownTurns: UnknownTurnRow[] = [];
  suggestions: SuggestionRow[] = [];
  versions: VersionRow[] = [];

  $transaction = async (callback: any) => callback(this);

  representative = {
    findUnique: async (args: any) =>
      this.representatives.find((rep) => rep.slug === args.where.slug) ?? null,
  };

  creatorTrainingSource = {
    findMany: async (args: any) =>
      this.sources
        .filter(
          (source) =>
            source.representativeId === args.where.representativeId &&
            (!args.where.status?.not || source.status !== args.where.status.not),
        )
        .slice(0, args.take),
  };

  creatorFeedbackSignal = {
    findMany: async (args: any) =>
      this.feedbackSignals
        .filter(
          (signal) =>
            signal.representativeId === args.where.representativeId &&
            (!args.where.status || signal.status === args.where.status),
        )
        .slice(0, args.take),
  };

  conversationTurn = {
    findMany: async (args: any) =>
      this.unknownTurns
        .filter(
          (turn) =>
            turn.representativeId === args.where.conversation.representativeId &&
            args.where.direction === "inbound" &&
            args.where.intent === "unknown",
        )
        .slice(0, args.take),
  };

  creatorTrainingVersion = {
    findFirst: async (args: any) => {
      const originKey = args.where.suggestion.is.originKey;
      const version = this.versions
        .filter(
          (candidate) =>
            candidate.representativeId === args.where.representativeId
            && candidate.status === args.where.status
            && this.suggestions.some(
              (suggestion) =>
                suggestion.id === candidate.suggestionId
                && suggestion.originKey === originKey,
            ),
        )
        .sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
      if (!version) return null;
      return {
        suggestion:
          this.suggestions.find((suggestion) => suggestion.id === version.suggestionId)
          ?? null,
      };
    },
  };

  creatorTrainingSuggestion = {
    findFirst: async (args: any) =>
      this.suggestions
        .filter(
          (suggestion) =>
            suggestion.representativeId === args.where.representativeId &&
            suggestion.originKey === args.where.originKey &&
            (!args.where.status || suggestion.status === args.where.status),
        )
        .sort((left, right) => right.originRevision - left.originRevision)[0] ?? null,
    updateMany: async (args: any) => {
      const matches = this.suggestions.filter(
        (suggestion) =>
          suggestion.representativeId === args.where.representativeId &&
          suggestion.originKey === args.where.originKey &&
          suggestion.status === args.where.status &&
          (!args.where.id?.not || suggestion.id !== args.where.id.not),
      );
      for (const suggestion of matches) {
        Object.assign(suggestion, args.data, {
          updatedAt: new Date("2026-07-04T12:10:00.000Z"),
        });
      }
      return { count: matches.length };
    },
    update: async (args: any) => {
      const suggestion = this.suggestions.find(
        (item) => item.id === args.where.id,
      );
      if (!suggestion) {
        throw new Error("suggestion not found");
      }
      Object.assign(suggestion, args.data, {
        updatedAt: new Date("2026-07-04T12:10:00.000Z"),
      });
      return suggestion;
    },
    create: async (args: any) => {
      const now = new Date(`2026-07-04T12:00:${String(this.suggestions.length).padStart(2, "0")}.000Z`);
      const suggestion: SuggestionRow = {
        id: `suggestion-${this.suggestions.length + 1}`,
        representativeId: args.data.representativeId,
        originKey: args.data.originKey,
        originRevision: args.data.originRevision,
        sourceId: args.data.sourceId ?? null,
        feedbackSignalId: args.data.feedbackSignalId ?? null,
        suggestionType: args.data.suggestionType,
        status: args.data.status,
        title: args.data.title,
        rationale: args.data.rationale,
        draftPayload: args.data.draftPayload,
        dedupeKey: args.data.dedupeKey,
        riskLevel: args.data.riskLevel,
        reviewedAt: null,
        reviewedBy: null,
        reviewNote: null,
        createdAt: now,
        updatedAt: now,
      };
      this.suggestions.push(suggestion);
      return suggestion;
    },
    findMany: async (args: any) =>
      this.suggestions
        .filter(
          (suggestion) =>
            suggestion.representativeId === args.where.representativeId &&
            (!args.where.status || suggestion.status === args.where.status),
        )
        .slice(0, args.take),
  };
}

function buildFeedback(overrides: Partial<FeedbackRow> = {}): FeedbackRow {
  return {
    id: "feedback-1",
    representativeId: "rep-1",
    contactId: null,
    conversationId: null,
    turnId: null,
    signalType: "CORRECTION",
    status: "new",
    publicSafe: true,
    note: null,
    suggestedText: null,
    createdBy: null,
    createdAt: new Date("2026-07-04T12:00:00.000Z"),
    updatedAt: new Date("2026-07-04T12:00:00.000Z"),
    ...overrides,
  };
}

function buildSource(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "source-1",
    representativeId: "rep-1",
    kind: "TEXT",
    status: "ACTIVE",
    title: "Training source",
    locator: null,
    contentText: "Training source content.",
    metadata: null,
    lastSyncedAt: null,
    errorReason: null,
    createdBy: "owner-dashboard",
    createdAt: new Date("2026-07-04T12:00:00.000Z"),
    updatedAt: new Date("2026-07-04T12:00:00.000Z"),
    ...overrides,
  };
}

function buildUnknownTurn(
  messageText: string,
  overrides: Partial<UnknownTurnRow> = {},
): UnknownTurnRow {
  return {
    messageText,
    conversationId: "conversation-1",
    representativeId: "rep-1",
    createdAt: new Date("2026-07-04T12:00:00.000Z"),
    ...overrides,
  };
}
