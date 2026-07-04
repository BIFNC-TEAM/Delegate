import { describe, expect, it } from "vitest";

import {
  createCreatorFeedbackSignal,
  listCreatorFeedbackSignals,
} from "../src/creator-training";

describe("creator feedback signals", () => {
  it("records creator correction without mutating the original turn", async () => {
    const client = new FakeCreatorTrainingFeedbackClient();

    const signal = await createCreatorFeedbackSignal(
      "lin",
      {
        signalType: "correction",
        turnId: "turn-1",
        publicSafe: true,
        suggestedText: "Use the official refund window.",
        note: "This can become a public FAQ.",
        createdBy: "owner-1",
      },
      client,
    );

    expect(signal).toMatchObject({
      representativeId: "rep-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      turnId: "turn-1",
      signalType: "correction",
      publicSafe: true,
    });
    expect(client.turns[0]?.messageText).toBe("original answer remains untouched");
  });

  it("records do_not_say as a private owner signal by default", async () => {
    const client = new FakeCreatorTrainingFeedbackClient();

    const signal = await createCreatorFeedbackSignal(
      "lin",
      {
        signalType: "do_not_say",
        conversationId: "conversation-1",
        note: "Never promise same-day refunds.",
      },
      client,
    );

    expect(signal.publicSafe).toBe(false);
    expect(signal.signalType).toBe("do_not_say");
    expect(signal.contactId).toBe("contact-1");
  });

  it("lists only feedback for the current representative and rejects cross-rep turns", async () => {
    const client = new FakeCreatorTrainingFeedbackClient();

    await createCreatorFeedbackSignal(
      "lin",
      {
        signalType: "suggested_answer",
        contactId: "contact-1",
        suggestedText: "Say this next time.",
      },
      client,
    );

    const signals = await listCreatorFeedbackSignals("lin", { status: "new" }, client);

    expect(signals).toHaveLength(1);
    await expect(
      createCreatorFeedbackSignal(
        "ada",
        {
          signalType: "approve",
          turnId: "turn-1",
        },
        client,
      ),
    ).rejects.toThrow("Conversation turn not found for representative.");
  });
});

type RepresentativeRow = {
  id: string;
  slug: string;
};

type ContactRow = {
  id: string;
  representativeId: string;
};

type ConversationRow = {
  id: string;
  representativeId: string;
  contactId: string;
};

type TurnRow = {
  id: string;
  conversationId: string;
  messageText: string;
};

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

class FakeCreatorTrainingFeedbackClient {
  representatives: RepresentativeRow[] = [
    { id: "rep-1", slug: "lin" },
    { id: "rep-2", slug: "ada" },
  ];
  contacts: ContactRow[] = [
    { id: "contact-1", representativeId: "rep-1" },
    { id: "contact-2", representativeId: "rep-2" },
  ];
  conversations: ConversationRow[] = [
    { id: "conversation-1", representativeId: "rep-1", contactId: "contact-1" },
    { id: "conversation-2", representativeId: "rep-2", contactId: "contact-2" },
  ];
  turns: TurnRow[] = [
    {
      id: "turn-1",
      conversationId: "conversation-1",
      messageText: "original answer remains untouched",
    },
  ];
  feedbackSignals: FeedbackRow[] = [];

  representative = {
    findUnique: async (args: any) =>
      this.representatives.find((rep) => rep.slug === args.where.slug) ?? null,
  };

  contact = {
    findFirst: async (args: any) =>
      this.contacts.find(
        (contact) =>
          contact.id === args.where.id && contact.representativeId === args.where.representativeId,
      ) ?? null,
  };

  conversation = {
    findFirst: async (args: any) =>
      this.conversations.find(
        (conversation) =>
          conversation.id === args.where.id &&
          conversation.representativeId === args.where.representativeId,
      ) ?? null,
  };

  conversationTurn = {
    findFirst: async (args: any) => {
      const turn = this.turns.find((item) => item.id === args.where.id);
      const conversation = turn
        ? this.conversations.find((item) => item.id === turn.conversationId)
        : null;
      if (!turn || conversation?.representativeId !== args.where.conversation.representativeId) {
        return null;
      }
      return {
        id: turn.id,
        conversationId: turn.conversationId,
      };
    },
  };

  creatorFeedbackSignal = {
    create: async (args: any) => {
      const now = new Date(`2026-07-04T12:00:${String(this.feedbackSignals.length).padStart(2, "0")}.000Z`);
      const signal: FeedbackRow = {
        id: `feedback-${this.feedbackSignals.length + 1}`,
        representativeId: args.data.representativeId,
        contactId: args.data.contactId ?? null,
        conversationId: args.data.conversationId ?? null,
        turnId: args.data.turnId ?? null,
        signalType: args.data.signalType,
        status: "new",
        publicSafe: args.data.publicSafe ?? false,
        note: args.data.note ?? null,
        suggestedText: args.data.suggestedText ?? null,
        createdBy: args.data.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.feedbackSignals.push(signal);
      return signal;
    },
    findMany: async (args: any) =>
      this.feedbackSignals
        .filter(
          (signal) =>
            signal.representativeId === args.where.representativeId &&
            (!args.where.status || signal.status === args.where.status),
        )
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, args.take),
  };
}
