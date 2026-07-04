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
        note: "Never promise guaranteed revenue.",
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
      dedupeKey: "unknown:what is your refund policy",
    });
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(listed).toHaveLength(1);
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
        dedupeKey: "source:source-upload-1:material_update",
        draftPayload: expect.objectContaining({
          kind: "download",
          title: "Workshop FAQ upload",
          summary: "The workshop refund window is seven days.",
        }),
      }),
    ]);
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

class FakeCreatorTrainingSuggestionClient {
  representatives = [
    { id: "rep-1", slug: "lin" },
    { id: "rep-2", slug: "ada" },
  ];
  sources: SourceRow[] = [];
  feedbackSignals: FeedbackRow[] = [];
  unknownTurns: UnknownTurnRow[] = [];
  suggestions: SuggestionRow[] = [];

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

  creatorTrainingSuggestion = {
    upsert: async (args: any) => {
      const key = args.where.representativeId_dedupeKey;
      const existing = this.suggestions.find(
        (suggestion) =>
          suggestion.representativeId === key.representativeId &&
          suggestion.dedupeKey === key.dedupeKey,
      );
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: new Date("2026-07-04T12:10:00.000Z") });
        return existing;
      }
      const now = new Date(`2026-07-04T12:00:${String(this.suggestions.length).padStart(2, "0")}.000Z`);
      const suggestion: SuggestionRow = {
        id: `suggestion-${this.suggestions.length + 1}`,
        representativeId: args.create.representativeId,
        sourceId: args.create.sourceId ?? null,
        feedbackSignalId: args.create.feedbackSignalId ?? null,
        suggestionType: args.create.suggestionType,
        status: args.create.status,
        title: args.create.title,
        rationale: args.create.rationale,
        draftPayload: args.create.draftPayload,
        dedupeKey: args.create.dedupeKey,
        riskLevel: args.create.riskLevel,
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

function buildUnknownTurn(messageText: string): UnknownTurnRow {
  return {
    messageText,
    conversationId: "conversation-1",
    representativeId: "rep-1",
    createdAt: new Date("2026-07-04T12:00:00.000Z"),
  };
}
