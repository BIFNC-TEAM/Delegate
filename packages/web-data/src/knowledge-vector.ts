import { knowledgeIngestionContext, KnowledgeProcessingPending } from "./knowledge-ingestion-context";
import { createHash } from "node:crypto";

import {
  buildOpenVikingAgentId,
  buildRepresentativeResourceRootUri,
  OpenVikingClient,
  resolveOpenVikingEnv,
  sanitizeVikingSegment,
} from "@delegate/openviking";

export type KnowledgeVectorIndexResult = {
  backend: "openviking" | "memory";
  uri: string;
  chunkCount: number;
  embeddingModel: string;
  indexedAt: Date;
};

const demoVectorIndex = new Map<string, Array<{ id: string; text: string; vector: number[] }>>();
const KNOWLEDGE_INDEX_TIMEOUT_SECONDS = 300;

export function splitKnowledgeText(text: string, chunkSize = 1_400, overlap = 180): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n\n+/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = value.slice(Math.max(0, value.length - overlap));
  };

  for (const paragraph of paragraphs) {
    const units = paragraph.length <= chunkSize
      ? [paragraph]
      : paragraph.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
    for (const unit of units) {
      if (unit.length > chunkSize) {
        if (current) flush();
        for (let offset = 0; offset < unit.length; offset += chunkSize - overlap) {
          chunks.push(unit.slice(offset, offset + chunkSize).trim());
        }
        current = "";
        continue;
      }
      const candidate = current ? `${current}\n\n${unit}` : unit;
      if (candidate.length > chunkSize && current) flush();
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return [...new Set(chunks.filter(Boolean))];
}

export async function indexKnowledgeText(params: {
  ownerId: string;
  assetId: string;
  title: string;
  text: string;
  checksum: string;
  representativeSlugs: string[];
  staleRepresentativeSlugs?: string[];
}): Promise<KnowledgeVectorIndexResult> {
  const chunks = splitKnowledgeText(params.text);
  if (!chunks.length) throw new Error("Knowledge content produced no indexable chunks.");
  const workspaceUri = buildWorkspaceKnowledgeUri(params.ownerId, params.assetId);

  if (useMemoryVectorIndex()) {
    const desiredUris = [workspaceUri, ...params.representativeSlugs.map((slug) => buildRepresentativeKnowledgeUri(slug, params.assetId))];
    for (const slug of params.staleRepresentativeSlugs ?? []) {
      demoVectorIndex.delete(buildRepresentativeKnowledgeUri(slug, params.assetId));
    }
    for (const uri of desiredUris) {
      demoVectorIndex.set(uri, chunks.map((text, index) => ({
        id: `${params.assetId}:${index}`,
        text,
        vector: deterministicDemoVector(text),
      })));
    }
    return {
      backend: "memory",
      uri: workspaceUri,
      chunkCount: chunks.length,
      embeddingModel: "deterministic-demo-embedding",
      indexedAt: new Date(),
    };
  }

  const env = resolveOpenVikingEnv();
  if (!env.enabled) throw new Error("OpenViking is disabled; knowledge cannot be marked ready without a vector index.");
  if (!env.hasModelCredentials) throw new Error("OpenViking embedding credentials are not configured.");
  const client = buildKnowledgeClient(params.ownerId);
  const staleUris = new Set((params.staleRepresentativeSlugs ?? []).map((slug) => buildRepresentativeKnowledgeUri(slug, params.assetId)));
  const targetUris = [workspaceUri, ...params.representativeSlugs.map((slug) => buildRepresentativeKnowledgeUri(slug, params.assetId))];
  const ingestion = knowledgeIngestionContext.getStore();
  if (!ingestion?.checkpoint.indexPrepared) {
    for (const uri of [...staleUris, ...targetUris]) await removeKnowledgeResource(client, uri);
    await ingestion?.save("indexPrepared", "yes");
  }

  const content = renderVectorDocument(params);
  try {
    for (const uri of targetUris) {
      const key = `index:${uri}`;
      if (ingestion?.checkpoint[`${key}:done`]) continue;
      let taskId = ingestion?.checkpoint[key];
      if (ingestion?.checkpoint[`${key}:submitted`] && !taskId) {
        const tasks = await client.findResourceTasks(uri).catch(() => []);
        const submittedAt = Number(ingestion.checkpoint[`${key}:submitted`]);
        taskId = tasks.filter((task) => task.created_at >= submittedAt - 1)
          .sort((left, right) => right.created_at - left.created_at)[0]?.task_id;
        if (!taskId) throw new KnowledgeProcessingPending("正在确认索引任务状态，请稍候。");
        await ingestion.save(key, taskId);
      }
      if (taskId) {
        let task;
        try { task = await client.getTask(taskId); }
        catch { throw new KnowledgeProcessingPending("暂时无法获取索引进度，后台将继续查询。"); }
        if (["failed", "cancelled"].includes(task.status) || task.result?.status === "error" || task.result?.errors?.length || Object.values(task.result?.queue_status ?? {}).some((queue) => (queue.error_count ?? 0) > 0)) {
          throw new Error(task.error || task.result?.errors?.join("；") || "索引处理失败，请重试。");
        }
        if (task.status !== "completed") throw new KnowledgeProcessingPending("正在建立检索索引。");
        await ingestion!.save(`${key}:done`, "yes");
        continue;
      }
      const temp = await client.tempUpload({
        filename: `${sanitizeVikingSegment(params.assetId)}.md`,
        content,
      });
      if (!temp.temp_file_id && !temp.temp_path) {
        throw new Error("OpenViking temporary upload returned no file identifier.");
      }
      await ingestion?.save(`${key}:submitted`, String(Date.now() / 1000));
      const submitted = await client.addResource({
        ...(temp.temp_file_id ? { tempFileId: temp.temp_file_id } : {}),
        ...(temp.temp_path ? { tempPath: temp.temp_path } : {}),
        to: uri,
        reason: "Delegate workspace knowledge asset ingestion",
        instruction: "Parse, segment, embed, and index this knowledge asset for permission-scoped retrieval.",
        wait: !ingestion,
        ...(!ingestion ? { timeout: KNOWLEDGE_INDEX_TIMEOUT_SECONDS } : {}),
      });
      if (submitted.status === "error" || submitted.status === "cancelled" || submitted.errors?.length) throw new Error(submitted.errors?.join("；") || "索引处理失败。");
      if (ingestion) {
        if (!submitted.task_id) throw new KnowledgeProcessingPending("正在确认索引任务编号。");
        await ingestion.save(key, submitted.task_id);
        throw new KnowledgeProcessingPending("正在建立检索索引。");
      }
    }
  } catch (error) {
    // A failed request does not cancel provider work. Never delete a potentially active resource.
    if (ingestion && !(error instanceof KnowledgeProcessingPending)) {
      const submitted = targetUris.some((uri) => ingestion.checkpoint[`index:${uri}:submitted`]);
      if (submitted && error instanceof Error && /timeout|abort|fetch|network/i.test(error.message)) {
        throw new KnowledgeProcessingPending("暂时无法获取索引进度，后台将继续查询。");
      }
    }
    throw error;
  }

  return {
    backend: "openviking",
    uri: workspaceUri,
    chunkCount: chunks.length,
    embeddingModel: env.embeddingModel,
    indexedAt: new Date(),
  };
}

export async function removeKnowledgeTextIndex(params: {
  ownerId: string;
  assetId: string;
  representativeSlugs: string[];
  required?: boolean;
}): Promise<void> {
  const uris = [
    buildWorkspaceKnowledgeUri(params.ownerId, params.assetId),
    ...params.representativeSlugs.map((slug) => buildRepresentativeKnowledgeUri(slug, params.assetId)),
  ];
  if (useMemoryVectorIndex()) {
    for (const uri of uris) demoVectorIndex.delete(uri);
    return;
  }
  const env = resolveOpenVikingEnv();
  if (!env.enabled) {
    if (params.required) {
      throw new Error("OpenViking is disabled; refusing to remove knowledge while its vector index may still exist.");
    }
    return;
  }
  const client = buildKnowledgeClient(params.ownerId);
  for (const uri of uris) await removeKnowledgeResource(client, uri);
}

export function buildWorkspaceKnowledgeUri(ownerId: string, assetId: string) {
  return `viking://resources/delegate/workspaces/${sanitizeVikingSegment(ownerId)}/knowledge/${sanitizeVikingSegment(assetId)}.md`;
}

function buildRepresentativeKnowledgeUri(representativeSlug: string, assetId: string) {
  return `${buildRepresentativeResourceRootUri(representativeSlug)}knowledge/${sanitizeVikingSegment(assetId)}.md`;
}

function buildKnowledgeClient(ownerId: string) {
  const env = resolveOpenVikingEnv();
  return new OpenVikingClient({
    baseUrl: env.baseUrl,
    ...(env.apiKey ? { apiKey: env.apiKey } : {}),
    timeoutMs: Math.max(env.timeoutMs, (KNOWLEDGE_INDEX_TIMEOUT_SECONDS + 15) * 1_000),
    accountId: "delegate",
    userId: `owner-${sanitizeVikingSegment(ownerId)}`,
    agentId: buildOpenVikingAgentId("knowledge-library", env),
  });
}

function removeKnowledgeResource(client: OpenVikingClient, uri: string) {
  // OpenViking treats addResource's `to` URI as a directory and stores the
  // uploaded document below it, even when the URI itself ends in `.md`.
  return client.remove(uri, true);
}

function renderVectorDocument(params: {
  assetId: string;
  title: string;
  text: string;
  checksum: string;
}) {
  return [
    `# ${params.title}`,
    "",
    `Asset-ID: ${params.assetId}`,
    `Content-SHA256: ${params.checksum}`,
    "",
    params.text,
  ].join("\n");
}

function useMemoryVectorIndex() {
  return !process.env.DATABASE_URL?.trim();
}

function deterministicDemoVector(text: string): number[] {
  const bytes = createHash("sha256").update(text).digest();
  return Array.from({ length: 16 }, (_, index) => (bytes[index]! / 255) * 2 - 1);
}
