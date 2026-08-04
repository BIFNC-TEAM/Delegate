import type { OpenVikingRecallItem } from "@delegate/openviking";

import { recallRepresentativeContext } from "@delegate/web-data";

import type { ConversationContextRecord } from "./runtime-store";

export async function recallOpenVikingContext(params: {
  context: ConversationContextRecord;
  queryText: string;
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
