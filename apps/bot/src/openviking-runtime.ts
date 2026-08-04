import type { ConversationContextRecord } from "./runtime-store";

export async function recallOpenVikingContext(params: {
  context: ConversationContextRecord;
  queryText: string;
}): Promise<[]> {
  void params;
  // Telegram's legacy/shadow runtime has no GenerationRun-bound MemoryUseRun,
  // so it must not inject long-term recall. Production Telegram recall is
  // handled only by the unified conversation worker.
  return [];
}
