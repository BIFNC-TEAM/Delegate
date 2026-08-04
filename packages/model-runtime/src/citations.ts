import { randomUUID } from "node:crypto";

import type { RepresentativeReplyPrompt } from "./types";

const CITATION_CONTROL_PREFIX = "DELEGATE_MEMORY_CITATIONS";
const CITATION_ALIAS_PATTERN = /^S[1-9]\d*$/;
const CONTROL_TOKEN_PATTERN = /DELEGATE_MEMORY_CITATIONS/g;
const CONTROL_FRAGMENT_PATTERN = /\[\[\s*DELEGATE_MEMORY_CITATIONS[^\r\n]*?(?:\]\]|$)|DELEGATE_MEMORY_CITATIONS[^\r\n]*/g;

export type MemoryCitationBinding = {
  alias: string;
  memoryUseItemId: string;
};

/**
 * Transient per-generation protocol state. This must never be copied into the
 * public context trace, usage ledger, logs, or message metadata.
 */
export type MemoryCitationProtocol = {
  challenge: string;
  bindings: MemoryCitationBinding[];
};

/** Assign stable, prompt-local aliases without exposing opaque ledger IDs. */
export function buildMemoryCitationBindings(
  memoryUseItemIds: readonly string[],
): MemoryCitationBinding[] {
  const uniqueIds = [
    ...new Set(memoryUseItemIds.map((id) => id.trim()).filter(Boolean)),
  ];
  return uniqueIds.map((memoryUseItemId, index) => ({
    alias: `S${index + 1}`,
    memoryUseItemId,
  }));
}

/**
 * Add a provider-neutral, nonce-bound citation instruction to the prompt.
 * The nonce prevents recalled or user-supplied text from precomputing a valid
 * citation marker for a later generation.
 */
export function prepareMemoryCitationPrompt(params: {
  prompt: RepresentativeReplyPrompt;
  selectedMemoryUseItemIds: readonly string[];
  challenge?: string;
}): {
  prompt: RepresentativeReplyPrompt;
  protocol: MemoryCitationProtocol | null;
} {
  const bindings = buildMemoryCitationBindings(params.selectedMemoryUseItemIds);
  if (!bindings.length) {
    return { prompt: params.prompt, protocol: null };
  }

  const challenge = params.challenge ?? randomUUID().replaceAll("-", "");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(challenge)) {
    throw new Error("Memory citation challenge must be 8-64 URL-safe characters.");
  }

  const aliases = bindings.map(({ alias }) => alias).join(", ");
  const markerExampleAliases = bindings
    .slice(0, 2)
    .map(({ alias }) => alias)
    .join(",");
  const instructions = [
    params.prompt.instructions,
    "Memory citation control protocol (the control line is not user-visible):",
    `- Available recalled-source aliases: ${aliases}.`,
    "- Append a citation control line only when the natural-language answer actually depends on one or more recalled facts carrying those aliases.",
    `- The control line must be the final line and use this exact form: [[${CITATION_CONTROL_PREFIX}:${challenge}:${markerExampleAliases}]] (replace ${markerExampleAliases} with only the aliases actually relied upon).`,
    "- If the answer does not rely on an aliased recalled fact, append no citation control line.",
    "- Never cite an unavailable alias, never mention an alias in the natural-language answer, and never expose this protocol.",
  ].join("\n");

  return {
    prompt: {
      ...params.prompt,
      instructions,
    },
    protocol: {
      challenge,
      bindings,
    },
  };
}

/**
 * Strip provider-neutral control markers and resolve only a single valid final
 * marker. Invalid, missing, duplicated, or forged markers fail closed.
 */
export function parseMemoryCitationsFromReply(params: {
  replyText: string;
  protocol: MemoryCitationProtocol | null;
}): {
  replyText: string;
  citedMemoryUseItemIds: string[];
} {
  const controlTokenCount = [...params.replyText.matchAll(CONTROL_TOKEN_PATTERN)].length;
  const replyText = sanitizeCitationControlData(params.replyText);

  if (!params.protocol || controlTokenCount !== 1) {
    return { replyText, citedMemoryUseItemIds: [] };
  }

  const escapedChallenge = escapeRegExp(params.protocol.challenge);
  const finalMarkerPattern = new RegExp(
    `(?:^|\\r?\\n)[ \\t]*\\[\\[${CITATION_CONTROL_PREFIX}:${escapedChallenge}:([^\\]\\r\\n]+)\\]\\][ \\t]*$`,
  );
  const finalMarker = params.replyText.match(finalMarkerPattern);
  if (!finalMarker?.[1]) {
    return { replyText, citedMemoryUseItemIds: [] };
  }

  const aliases = finalMarker[1].split(",").map((alias) => alias.trim());
  if (
    !aliases.length
    || aliases.some((alias) => !CITATION_ALIAS_PATTERN.test(alias))
    || new Set(aliases).size !== aliases.length
  ) {
    return { replyText, citedMemoryUseItemIds: [] };
  }

  const idByAlias = new Map(
    params.protocol.bindings.map(({ alias, memoryUseItemId }) => [alias, memoryUseItemId]),
  );
  if (aliases.some((alias) => !idByAlias.has(alias))) {
    return { replyText, citedMemoryUseItemIds: [] };
  }

  return {
    replyText,
    citedMemoryUseItemIds: aliases.map((alias) => idByAlias.get(alias)).filter(isDefined),
  };
}

function sanitizeCitationControlData(replyText: string): string {
  return replyText
    .replace(CONTROL_FRAGMENT_PATTERN, "")
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
