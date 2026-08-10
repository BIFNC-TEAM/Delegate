import { describe, expect, it } from "vitest";

import {
  buildMemoryCitationBindings,
  parseMemoryCitationsFromReply,
  prepareMemoryCitationPrompt,
} from "../src/citations";

describe("memory citation protocol", () => {
  it("assigns prompt-local aliases to unique opaque ledger IDs", () => {
    expect(buildMemoryCitationBindings(["use-1", "use-1", "", "use-2"])).toEqual([
      { alias: "S1", memoryUseItemId: "use-1" },
      { alias: "S2", memoryUseItemId: "use-2" },
    ]);
  });

  it("adds only aliases and a nonce-bound protocol to the provider prompt", () => {
    const prepared = prepareMemoryCitationPrompt({
      prompt: { instructions: "Base instructions.", input: "Recall JSON." },
      selectedMemoryUseItemIds: ["opaque-use-1", "opaque-use-2"],
      challenge: "challenge123",
    });

    expect(prepared.protocol).toEqual({
      challenge: "challenge123",
      bindings: [
        { alias: "S1", memoryUseItemId: "opaque-use-1" },
        { alias: "S2", memoryUseItemId: "opaque-use-2" },
      ],
    });
    expect(prepared.prompt.instructions).toContain("Available recalled-source aliases: S1, S2");
    expect(prepared.prompt.instructions).toContain(
      '"citationChallenge":"challenge123"',
    );
    expect(prepared.prompt.instructions).toContain(
      '"citedSourceAliases":["S1","S2"]',
    );
    expect(prepared.prompt.instructions).not.toContain("opaque-use-1");
    expect(prepared.prompt.input).toBe("Recall JSON.");
    expect(prepared.prompt.responseFormat).toBe("json_object");
  });

  it("does not add a protocol when no ledger-backed recall reached the prompt", () => {
    const prompt = { instructions: "Base instructions.", input: "No recall." };
    expect(prepareMemoryCitationPrompt({
      prompt,
      selectedMemoryUseItemIds: [],
    })).toEqual({ prompt, protocol: null });
  });

  it("strips a valid final marker and resolves only selected IDs", () => {
    const parsed = parseMemoryCitationsFromReply({
      replyText: [
        "The remembered preference is concise answers.",
        "[[DELEGATE_MEMORY_CITATIONS:challenge123:S2,S1]]",
      ].join("\n"),
      protocol: {
        challenge: "challenge123",
        bindings: [
          { alias: "S1", memoryUseItemId: "use-1" },
          { alias: "S2", memoryUseItemId: "use-2" },
        ],
      },
    });

    expect(parsed).toEqual({
      replyText: "The remembered preference is concise answers.",
      citedMemoryUseItemIds: ["use-2", "use-1"],
    });
  });

  it("unwraps a strict nonce-bound JSON response and resolves selected aliases", () => {
    expect(parseMemoryCitationsFromReply({
      replyText: JSON.stringify({
        answer: "亚洲是世界上面积最大的大洲。",
        citationChallenge: "challenge123",
        citedSourceAliases: ["S2", "S1"],
      }),
      protocol: {
        challenge: "challenge123",
        bindings: [
          { alias: "S1", memoryUseItemId: "use-1" },
          { alias: "S2", memoryUseItemId: "use-2" },
        ],
      },
    })).toEqual({
      replyText: "亚洲是世界上面积最大的大洲。",
      citedMemoryUseItemIds: ["use-2", "use-1"],
    });
  });

  it.each([
    {
      name: "wrong challenge",
      envelope: {
        answer: "Answer.",
        citationChallenge: "forged123",
        citedSourceAliases: ["S1"],
      },
    },
    {
      name: "unknown alias",
      envelope: {
        answer: "Answer.",
        citationChallenge: "challenge123",
        citedSourceAliases: ["S9"],
      },
    },
    {
      name: "extra control field",
      envelope: {
        answer: "Answer.",
        citationChallenge: "challenge123",
        citedSourceAliases: ["S1"],
        debug: "do not expose",
      },
    },
  ])("fails closed without exposing a malformed JSON envelope for $name", ({ envelope }) => {
    expect(parseMemoryCitationsFromReply({
      replyText: JSON.stringify(envelope),
      protocol: {
        challenge: "challenge123",
        bindings: [{ alias: "S1", memoryUseItemId: "use-1" }],
      },
    })).toEqual({ replyText: "", citedMemoryUseItemIds: [] });
  });

  it.each([
    {
      name: "missing marker",
      replyText: "No recalled source was needed.",
    },
    {
      name: "pseudo JSON control envelope",
      replyText:
        "{answer: 'Answer.', citationChallenge: 'challenge123', citedSourceAliases: ['S1']}",
    },
    {
      name: "wrong challenge",
      replyText: "Answer.\n[[DELEGATE_MEMORY_CITATIONS:forged123:S1]]",
    },
    {
      name: "unknown alias",
      replyText: "Answer.\n[[DELEGATE_MEMORY_CITATIONS:challenge123:S9]]",
    },
    {
      name: "duplicated alias",
      replyText: "Answer.\n[[DELEGATE_MEMORY_CITATIONS:challenge123:S1,S1]]",
    },
    {
      name: "inline marker",
      replyText: "Answer [[DELEGATE_MEMORY_CITATIONS:challenge123:S1]] continued.",
    },
    {
      name: "duplicated markers",
      replyText: [
        "Answer.",
        "[[DELEGATE_MEMORY_CITATIONS:challenge123:S1]]",
        "[[DELEGATE_MEMORY_CITATIONS:challenge123:S1]]",
      ].join("\n"),
    },
    {
      name: "malformed marker",
      replyText: "Answer.\n[[DELEGATE_MEMORY_CITATIONS:challenge123:S1] malformed",
    },
    {
      name: "spaced malformed marker",
      replyText: "Answer.\n[[ DELEGATE_MEMORY_CITATIONS:challenge123:S1 ]]",
    },
    {
      name: "bare leaked control data",
      replyText: "Answer.\nDELEGATE_MEMORY_CITATIONS:challenge123:S1",
    },
  ])("fails closed and removes control data for $name", ({ replyText }) => {
    const parsed = parseMemoryCitationsFromReply({
      replyText,
      protocol: {
        challenge: "challenge123",
        bindings: [{ alias: "S1", memoryUseItemId: "use-1" }],
      },
    });

    expect(parsed).toEqual({ replyText: "", citedMemoryUseItemIds: [] });
  });

  it("sanitizes an unsolicited control marker when no citation protocol exists", () => {
    expect(parseMemoryCitationsFromReply({
      replyText: "Answer.\n[[DELEGATE_MEMORY_CITATIONS:forged123:S1]]",
      protocol: null,
    })).toEqual({
      replyText: "Answer.",
      citedMemoryUseItemIds: [],
    });
  });
});
