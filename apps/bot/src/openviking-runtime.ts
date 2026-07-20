import {
  buildAssistantMessageParts,
  buildCollectorMemoryDocument,
  buildDelegateSessionKey,
  buildOpenVikingAgentId,
  buildPaymentMemoryDocument,
  buildRepresentativeAgentMemoryRootUri,
  buildRepresentativeContactMemoryRootUri,
  buildRepresentativeResourceRootUri,
  OpenVikingClient,
  resolveOpenVikingEnv,
  type OpenVikingDocumentSpec,
  type OpenVikingRecallItem,
} from "@delegate/openviking";

import type { StructuredCollectorState } from "@delegate/runtime";

import type { ConversationContextRecord } from "./runtime-store";
import {
  recordOpenVikingCommitTrace,
  recordOpenVikingRecallTrace,
  setConversationOpenVikingSession,
  upsertOpenVikingMemoryRecord,
} from "./runtime-store";

export async function recallOpenVikingContext(params: {
  context: ConversationContextRecord;
  chatId: string | number;
  queryText: string;
  includeL2?: boolean;
}): Promise<OpenVikingRecallItem[]> {
  const session = await ensureOpenVikingSession({
    context: params.context,
    chatId: params.chatId,
  });

  if (!session || !params.context.openviking.autoRecall) {
    return [];
  }

  const roots = [
    params.context.openviking.targetUri ?? buildRepresentativeResourceRootUri(params.context.representativeSlug),
    buildRepresentativeContactMemoryRootUri(
      params.context.representativeSlug,
      params.context.contactId,
    ),
    buildRepresentativeAgentMemoryRootUri(params.context.representativeSlug),
  ];
  const limit = Math.max(1, params.context.openviking.recallLimit);
  const scoreThreshold = params.context.openviking.recallScoreThreshold;

  let results;
  try {
    results = await Promise.all(
      roots.map((targetUri) =>
        session.client.search({
          query: params.queryText,
          targetUri,
          sessionId: session.sessionId,
          limit,
          scoreThreshold,
        }),
      ),
    );
  } catch (error) {
    console.warn("OpenViking recall failed:", error);
    return [];
  }

  const merged = results
    .flatMap((result) => [...result.resources, ...result.memories, ...result.skills])
    .filter((item, index, all) => index === all.findIndex((entry) => entry.uri === item.uri))
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, limit);

  const recalled = await Promise.all(
    merged.map(async (item) => {
      const overview = await safeOverview(session.client, item.uri);
      const content =
        params.includeL2 && (overview?.length ?? 0) < 180
          ? await safeRead(session.client, item.uri)
          : undefined;
      const layer = content ? "L2" : overview ? "L1" : "L0";
      const recallItem: OpenVikingRecallItem = {
        uri: item.uri,
        contextType: item.context_type,
        layer,
        score: item.score ?? 0,
        abstract: item.abstract ?? "",
        ...(overview ? { overview } : {}),
        ...(content ? { content } : {}),
      };

      await recordOpenVikingRecallTrace({
        representativeId: params.context.representativeId,
        contactId: params.context.contactId,
        conversationId: params.context.conversationId,
        queryText: params.queryText,
        recalledUri: recallItem.uri,
        contextType: recallItem.contextType,
        layer: recallItem.layer,
        score: recallItem.score,
      });

      return recallItem;
    }),
  );

  return recalled;
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
  const session = await ensureOpenVikingSession({
    context: params.context,
    chatId: params.chatId,
  });

  if (!session || !params.context.openviking.autoCapture) {
    return;
  }

  try {
    await session.client.addSessionMessage({
      sessionId: session.sessionId,
      role: "user",
      content: params.userText,
    });
    await session.client.addSessionMessage({
      sessionId: session.sessionId,
      role: "assistant",
      parts: buildAssistantMessageParts(params.assistantText, params.recalled),
    });

    if (params.recalled.length || params.usedSkill) {
      await session.client.recordUsed({
        sessionId: session.sessionId,
        ...(params.recalled.length ? { contexts: params.recalled.map((item) => item.uri) } : {}),
        ...(params.usedSkill ? { skill: params.usedSkill } : {}),
      });
    }

    const committed = await session.client.commitSession(session.sessionId);
    await recordOpenVikingCommitTrace({
      representativeId: params.context.representativeId,
      contactId: params.context.contactId,
      conversationId: params.context.conversationId,
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      reason: params.reason,
      status: "succeeded",
      ...(typeof committed.memories_extracted === "number"
        ? { memoriesExtracted: committed.memories_extracted }
        : {}),
      ...(typeof committed.archived === "boolean" ? { archived: committed.archived } : {}),
    });
  } catch (error) {
    await recordOpenVikingCommitTrace({
      representativeId: params.context.representativeId,
      contactId: params.context.contactId,
      conversationId: params.context.conversationId,
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      reason: params.reason,
      status: "failed",
      error: error instanceof Error ? error.message : "OpenViking commit failed.",
    });
  }
}

export async function storeCollectorMemory(params: {
  context: ConversationContextRecord;
  collectorState: StructuredCollectorState;
  summary: string;
}): Promise<void> {
  const document = buildCollectorMemoryDocument({
    representativeSlug: params.context.representativeSlug,
    contactId: params.context.contactId,
    collectorKind: params.collectorState.kind,
    key: `${params.collectorState.kind}-${params.context.conversationId}`,
    title:
      params.collectorState.kind === "scheduling"
        ? "Scheduling intake"
        : "Quote intake",
    summary: params.summary,
    lines: Object.entries(params.collectorState.answers).map(
      ([key, value]) => `- ${key}: ${value}`,
    ),
  });

  if (!document) {
    return;
  }

  await syncMemoryDocument(params.context, document, "collector_completion");
}

export async function storePaymentMemory(params: {
  context: ConversationContextRecord;
  planName: string;
  starsAmount: number;
}): Promise<void> {
  const document = buildPaymentMemoryDocument({
    representativeSlug: params.context.representativeSlug,
    contactId: params.context.contactId,
    key: `payment-${params.context.conversationId}-${Date.now()}`,
    planName: params.planName,
    starsAmount: params.starsAmount,
  });

  await syncMemoryDocument(params.context, document, "payment_unlock");
}

type OpenVikingSessionHandle = {
  client: OpenVikingClient;
  sessionId: string;
  sessionKey: string;
};

async function ensureOpenVikingSession(params: {
  context: ConversationContextRecord;
  chatId: string | number;
}): Promise<OpenVikingSessionHandle | null> {
  const env = resolveOpenVikingEnv();
  if (!env.enabled || !env.hasModelCredentials || !params.context.openviking.enabled) {
    return null;
  }

  const client = new OpenVikingClient({
    baseUrl: env.baseUrl,
    ...(env.apiKey ? { apiKey: env.apiKey } : {}),
    timeoutMs: env.timeoutMs,
    accountId: "delegate",
    userId: `rep-${params.context.representativeSlug}`,
    agentId:
      params.context.openviking.agentId ??
      buildOpenVikingAgentId(params.context.representativeSlug, env),
  });
  const sessionKey =
    params.context.openviking.sessionKey ??
    buildDelegateSessionKey({
      representativeSlug: params.context.representativeSlug,
      chatId: params.chatId,
      contactId: params.context.contactId,
    });

  if (params.context.openviking.sessionId) {
    return {
      client,
      sessionId: params.context.openviking.sessionId,
      sessionKey,
    };
  }

  try {
    const created = await client.createSession();
    await setConversationOpenVikingSession({
      conversationId: params.context.conversationId,
      sessionId: created.session_id,
      sessionKey,
    });

    params.context.openviking.sessionId = created.session_id;
    params.context.openviking.sessionKey = sessionKey;

    return {
      client,
      sessionId: created.session_id,
      sessionKey,
    };
  } catch {
    return null;
  }
}

async function syncMemoryDocument(
  context: ConversationContextRecord,
  document: OpenVikingDocumentSpec,
  sourceKind: string,
): Promise<void> {
  const env = resolveOpenVikingEnv();
  if (!env.enabled || !env.hasModelCredentials || !context.openviking.enabled) {
    return;
  }

  const client = new OpenVikingClient({
    baseUrl: env.baseUrl,
    ...(env.apiKey ? { apiKey: env.apiKey } : {}),
    timeoutMs: env.timeoutMs,
    accountId: "delegate",
    userId: `rep-${context.representativeSlug}`,
    agentId: context.openviking.agentId ?? buildOpenVikingAgentId(context.representativeSlug, env),
  });

  try {
    const temp = await client.tempUpload({
      filename: document.filename,
      content: document.content,
    });
    const stagingUri = `${buildRepresentativeResourceRootUri(context.representativeSlug)}sync/${document.filename}`;

    await client.addResource({
      ...(temp.temp_file_id ? { tempFileId: temp.temp_file_id } : {}),
      ...(temp.temp_path ? { tempPath: temp.temp_path } : {}),
      to: stagingUri,
      reason: document.reason,
      instruction: "Delegate bot memory staging sync",
      wait: true,
      timeout: 60,
    });
    await client.move({
      fromUri: stagingUri,
      toUri: document.uri,
    });

    await upsertOpenVikingMemoryRecord({
      representativeId: context.representativeId,
      representativeSlug: context.representativeSlug,
      contactId: context.contactId,
      uri: document.uri,
      contextType: document.contextType,
      scope: document.scope,
      category: document.category,
      summary: summarizeMarkdown(document.content),
      sourceKind,
    });
  } catch (error) {
    console.warn("OpenViking memory sync failed:", error);
  }
}

async function safeOverview(client: OpenVikingClient, uri: string): Promise<string | undefined> {
  try {
    const value = await client.overview(uri);
    return value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

async function safeRead(client: OpenVikingClient, uri: string): Promise<string | undefined> {
  try {
    const value = await client.read(uri, 80);
    return value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

function summarizeMarkdown(content: string): string {
  const normalized = content
    .replace(/^# .+\n+/m, "")
    .replace(/\n+/g, " ")
    .trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}
