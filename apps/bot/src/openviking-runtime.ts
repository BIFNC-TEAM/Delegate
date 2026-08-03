import type { OpenVikingRecallItem } from "@delegate/openviking";

import type { StructuredCollectorState } from "@delegate/runtime";
import { recallRepresentativeContext } from "@delegate/web-data";

import type { ConversationContextRecord } from "./runtime-store";

export async function recallOpenVikingContext(params: {
  context: ConversationContextRecord;
  chatId: string | number;
  queryText: string;
  includeL2?: boolean;
}): Promise<OpenVikingRecallItem[]> {
  if (!params.context.openviking.autoRecall) {
    return [];
  }

  try {
    const recalled = await recallRepresentativeContext({
      representativeSlug: params.context.representativeSlug,
      conversationId: params.context.conversationId,
      contactId: params.context.contactId,
      sourceChannel: "telegram",
      queryText: params.queryText,
    });
    return recalled.items;
  } catch (error) {
    console.warn("OpenViking recall failed:", error);
    return [];
  }
}

export async function captureTurnToOpenViking(params: {
  context: ConversationContextRecord;
  chatId: string | number;
  userText: string;
  assistantText: string;
  recalled: OpenVikingRecallItem[];
  reason: string;
  usedSkill?: {
    uri: string;
    input?: Record<string, unknown>;
    output?: string;
    success: boolean;
  };
}): Promise<void> {
  // Fail closed until long-term memory has explicit promotion, deletion,
  // retention, and audit controls. Recall of already-governed context remains
  // available through recallOpenVikingContext.
  void params;
}

export async function storeCollectorMemory(params: {
  context: ConversationContextRecord;
  collectorState: StructuredCollectorState;
  summary: string;
}): Promise<void> {
  void params;
}

export async function storePaymentMemory(params: {
  context: ConversationContextRecord;
  planName: string;
  starsAmount: number;
}): Promise<void> {
  void params;
}
