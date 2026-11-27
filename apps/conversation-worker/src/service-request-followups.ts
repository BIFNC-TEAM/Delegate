import { V2RecoverableToolError } from "@delegate/model-runtime/v2";

type PendingFollowUps = { items: Array<{ id: string; question: string; originalSummary: string }>; hasMore: boolean };
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

/** A model may choose a target, but must ground a multi-question choice in
 * the current visitor text. Prior turns and the answer value are not a choice. */
export async function prepareServiceRequestChange(value: unknown, pending: PendingFollowUps, userText: string,
  verifyQuote?: (normalizedQuote: string) => Promise<string | null>): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { targetQuote, ...operation } = value as Record<string, unknown>;
  if (operation.operation !== "successor" || operation.mode !== "answer" || pending.items.length < 2 && !pending.hasMore) return operation;
  const quote = typeof targetQuote === "string" ? normalize(targetQuote) : "";
  const matches = quote ? pending.items.filter(item => normalize(item.question).includes(quote) || normalize(item.originalSummary).includes(quote)) : [];
  let targetId: string | null = null;
  if (quote && normalize(userText).includes(quote)) {
    if (verifyQuote) targetId = await verifyQuote(quote);
    else if (!pending.hasMore && matches.length === 1) targetId = matches[0]!.id;
  }
  if (!targetId || targetId !== operation.id) {
    throw new V2RecoverableToolError("not_dispatched", "ambiguous_follow_up",
      "No answer was submitted. Multiple pending questions require an explicit distinguishing subject quoted from the CURRENT visitor message as targetQuote. A bare answer value or a subject from old history is not a selection. Ask which pending question/product the visitor means; do not guess, invent a quote, or claim submission.");
  }
  return operation;
}
